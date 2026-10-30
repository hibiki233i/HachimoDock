// Wi-Fi link slot rules: USB keeps priority, and a failed attempt never drops a working link.
fn idle_connection(port_name: &str, connection_id: u64) -> (UsbConnection, Arc<AtomicBool>) {
    let cancel_reader = Arc::new(AtomicBool::new(false));
    let connection = UsbConnection {
        connection_id,
        port_name: port_name.to_string(),
        baud_rate: 0,
        writer: Box::new(std::io::sink()),
        board_device_id: "p4-aa".into(),
        runtime: "esp-p4".into(),
        device_model: String::new(),
        firmware: String::new(),
        build_id: String::new(),
        git_sha: String::new(),
        build_dirty: false,
        protocol_schema: 7,
        wire_protocol: String::new(),
        capabilities: serde_json::Value::Null,
        connected: true,
        cancel_reader: Arc::clone(&cancel_reader),
        capture_active: Arc::new(AtomicBool::new(false)),
    };
    (connection, cancel_reader)
}

fn assert_link_kept(manager: &UsbSerialManager, port_name: &str, cancel_reader: &AtomicBool) {
    let slot = manager.connection.lock().unwrap();
    let kept = slot.as_ref().expect("the existing link must stay in the connection slot");
    assert!(kept.connected && kept.port_name == port_name);
    assert!(!cancel_reader.load(Ordering::SeqCst), "its reader must keep running");
}

/// A loopback board speaking the real handshake: challenge, mutual proofs, bind -> hello. It then
/// sends a keepalive and a key event, and stays open until the desktop closes the link.
fn spawn_fake_board(board: &'static str, secret: String) -> (std::net::SocketAddr, thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);
        let mut send = |topic: &str, payload: serde_json::Value| {
            let mut line = serde_json::json!({"topic": topic, "payload": payload}).to_string();
            line.push('\n');
            writer.write_all(line.as_bytes()).unwrap();
        };
        let device_nonce = "0123456789abcdef0123456789abcdef";
        send("net/challenge", serde_json::json!({"boardDeviceId": board, "nonce": device_nonce}));
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let auth: serde_json::Value = serde_json::from_str(&line).unwrap();
        let client_nonce = auth["payload"]["nonce"].as_str().unwrap().to_string();
        assert_eq!(
            auth["payload"]["proof"],
            network_transport::client_proof(&secret, board, device_nonce, &client_nonce)
        );
        send(
            "net/auth_ok",
            serde_json::json!({"proof": network_transport::server_proof(&secret, board, device_nonce, &client_nonce)}),
        );
        line.clear();
        reader.read_line(&mut line).unwrap();
        assert!(line.contains("\"bind\""), "the desktop binds after authenticating: {line}");
        send("hello", serde_json::json!({"boardDeviceId": board, "runtime": "esp-p4", "fw": "0.0.0-test"}));
        send("net/keepalive", serde_json::json!({"uptimeMs": 1}));
        send("input/event", serde_json::json!({"action": "select"}));
        line.clear();
        while reader.read_line(&mut line).map(|n| n > 0).unwrap_or(false) {
            line.clear();
        }
    });
    (addr, handle)
}

#[test]
fn wifi_connect_never_displaces_a_live_usb_link() {
    let manager = UsbSerialManager::new();
    let (usb, cancel_reader) = idle_connection("/dev/cu.usbmodem-test", 1);
    *manager.connection.lock().unwrap() = Some(usb);
    let secret = network_transport::generate_secret();

    let error = manager
        .connect_network("p4-aa", "127.0.0.1:9".parse().unwrap(), &secret, |_, _| {})
        .unwrap_err();

    assert_eq!(error, network_transport::USB_PRIORITY_MESSAGE);
    assert_link_kept(&manager, "/dev/cu.usbmodem-test", &cancel_reader);
}

#[test]
fn failed_wifi_attempt_keeps_the_existing_wifi_link() {
    let manager = UsbSerialManager::new();
    let (wifi, cancel_reader) = idle_connection("wifi://192.168.1.9:38517", 1);
    *manager.connection.lock().unwrap() = Some(wifi);
    // A port that was just released: the connection is refused immediately.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    let secret = network_transport::generate_secret();

    assert!(manager.connect_network("p4-aa", closed, &secret, |_, _| {}).is_err());

    assert_link_kept(&manager, "wifi://192.168.1.9:38517", &cancel_reader);
}

#[test]
fn authenticated_wifi_connect_replaces_the_old_wifi_link_and_delivers_events() {
    let manager = UsbSerialManager::new();
    let (old, old_cancel) = idle_connection("wifi://192.168.1.9:38517", 1);
    *manager.connection.lock().unwrap() = Some(old);
    let secret = network_transport::generate_secret();
    let (addr, board) = spawn_fake_board("p4-aa", secret.clone());
    let (tx, rx) = mpsc::channel();

    manager
        .connect_network("p4-aa", addr, &secret, move |topic, _payload| {
            let _ = tx.send(topic);
        })
        .unwrap();

    assert!(old_cancel.load(Ordering::SeqCst), "the superseded link's reader is stopped");
    let status = manager.status();
    assert!(status.connected);
    assert_eq!(status.transport, "wifi");
    assert_eq!(status.port_name, network_transport::network_port_name(&addr));
    assert_eq!(status.board_device_id, "p4-aa");

    // hello comes from the handshake; the key event reaches the callback through the shared reader
    // thread, while the board's keepalive is consumed there and never surfaces.
    assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), "hello");
    assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), "input/event");
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err(), "net/keepalive must not reach the app");

    manager.disconnect();
    board.join().unwrap();
}

#[test]
fn device_voice_command_never_leaves_over_wifi() {
    // On the P4, `audio_bridge` arms the microphone on the link that sent it; PCM would then
    // stream over the unencrypted LAN.
    let arm = serde_json::json!({"type": "audio_bridge", "action": "start"});
    let manager = UsbSerialManager::new();
    let (wifi, _) = idle_connection("wifi://192.168.1.9:38517", 1);
    *manager.connection.lock().unwrap() = Some(wifi);
    assert!(manager.send("control/command", &arm).is_err());
    assert!(manager.require_usb_link("设备语音").is_err());

    let (usb, _) = idle_connection("/dev/cu.usbmodem-test", 2);
    *manager.connection.lock().unwrap() = Some(usb);
    manager.send("control/command", &arm).unwrap();
    manager.require_usb_link("设备语音").unwrap();
}
