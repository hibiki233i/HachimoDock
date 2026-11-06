/*
 * [Input] Serial port names/baud rates plus verified connection metadata.
 * [Output] Paired reader/writer handles (overlapped on Windows), retry-safe opens, and owned live connection state.
 * [Pos] OS handle and connection-ownership boundary beneath usb_serial.rs.
 * [Sync] If this file changes, update `pc/.folder.md`.
 */

use super::SerialMessage;
use serde_json::Value;
use std::io::{BufReader, Read, Write};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

pub(super) struct ProbedSerialPort<W = Box<dyn serialport::SerialPort>, R = Box<dyn serialport::SerialPort>> {
    pub(super) writer: W,
    pub(super) reader: BufReader<R>,
    pub(super) baud: u32,
    pub(super) hello: SerialMessage,
}

impl<W, R: Read> ProbedSerialPort<W, R> {
    // Move the SAME reader across the verified handshake boundary. into_inner
    // would discard bytes already read from the driver after the hello line.
    pub(super) fn from_verified_reader(writer: W, reader: BufReader<R>, baud: u32, hello: SerialMessage) -> Self {
        Self { writer, reader, baud, hello }
    }
}

type SerialPortHandle = Box<dyn serialport::SerialPort>;
type SerialPortPair = (SerialPortHandle, SerialPortHandle);
type SerialPortPairResult = Result<SerialPortPair, String>;

#[cfg(windows)]
const SERIAL_IO_TIMEOUT: Duration = Duration::from_millis(20);
#[cfg(not(windows))]
const SERIAL_IO_TIMEOUT: Duration = Duration::from_millis(100);

pub(super) struct UsbConnection {
    pub(super) connection_id: u64,
    pub(super) port_name: String,
    pub(super) baud_rate: u32,
    pub(super) writer: Box<dyn Write + Send>,
    pub(super) board_device_id: String,
    pub(super) runtime: String,
    pub(super) device_model: String,
    pub(super) firmware: String,
    pub(super) build_id: String,
    pub(super) git_sha: String,
    pub(super) build_dirty: bool,
    pub(super) protocol_schema: u32,
    pub(super) wire_protocol: String,
    pub(super) capabilities: Value,
    pub(super) connected: bool,
    pub(super) cancel_reader: Arc<AtomicBool>,
    pub(super) capture_active: Arc<AtomicBool>,
}

pub(super) fn serial_open_error_is_transient(error: &str) -> bool {
    error.contains("Access is denied")
        || error.contains("Unable to acquire exclusive lock")
        || error.contains("Resource busy")
        || error.contains("Device busy")
        || error.contains("拒绝访问")
}

#[cfg(windows)]
fn clear_serial_handle_inheritance(port: &impl std::os::windows::io::AsRawHandle) -> Result<(), String> {
    use std::ffi::c_void;

    const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;

    #[link(name = "kernel32")]
    extern "system" {
        fn SetHandleInformation(handle: *mut c_void, mask: u32, flags: u32) -> i32;
    }

    let ok = unsafe { SetHandleInformation(port.as_raw_handle().cast(), HANDLE_FLAG_INHERIT, 0) };
    if ok == 0 {
        Err(format!(
            "failed to make serial handle non-inheritable: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn open_serial_pair(port_name: &str, baud: u32) -> SerialPortPairResult {
    let port = super::windows_serial::WindowsSerialPort::open(port_name, baud, SERIAL_IO_TIMEOUT)
        .map_err(|error| error.to_string())?;
    clear_serial_handle_inheritance(&port)?;

    // serialport's Windows clone requests an inheritable duplicate, so clear
    // the flag on both handles before any Bridge/voice child can be spawned.
    let reader = port.try_clone_native().map_err(|error| error.to_string())?;
    clear_serial_handle_inheritance(&reader)?;
    Ok((Box::new(port), Box::new(reader)))
}

// The OS raises DTR and RTS on open, which is the idle state of the ESP
// auto-reset pair. DTR must stay put here: dropping it alone pulls EN low.
#[cfg(not(windows))]
fn serial_port_builder(port_name: &str, baud: u32) -> serialport::SerialPortBuilder {
    serialport::new(port_name, baud).timeout(SERIAL_IO_TIMEOUT).preserve_dtr_on_open()
}

// Runtime discovery is not a flashing/reset operation. RTS goes first because
// DTR-then-RTS reboots the board; best effort keeps CDC drivers without
// modem-line ioctls compatible.
pub(super) fn release_control_lines(port: &mut dyn serialport::SerialPort) {
    let _ = port.write_request_to_send(false);
    let _ = port.write_data_terminal_ready(false);
}

#[cfg(not(windows))]
fn open_serial_pair(port_name: &str, baud: u32) -> SerialPortPairResult {
    let mut port = serial_port_builder(port_name, baud)
        .open()
        .map_err(|error| error.to_string())?;
    release_control_lines(port.as_mut());
    let reader = port.try_clone().map_err(|error| error.to_string())?;
    Ok((port, reader))
}

pub(super) fn open_serial_pair_with_retry(port_name: &str, baud: u32) -> SerialPortPairResult {
    let mut last_open_error = String::new();
    for attempt in 0..6 {
        match open_serial_pair(port_name, baud) {
            Ok(ports) => return Ok(ports),
            Err(error) => {
                last_open_error = error;
                if serial_open_error_is_transient(&last_open_error) && attempt < 5 {
                    thread::sleep(Duration::from_millis(220));
                    continue;
                }
                break;
            }
        }
    }
    Err(format!(
        "failed to open {port_name} at {baud} baud: {last_open_error}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serialport::{ClearBuffer, DataBits, FlowControl, Parity, SerialPort, StopBits};
    use std::io;

    #[derive(Default)]
    struct LineRecorder { writes: Vec<&'static str> }
    impl Read for LineRecorder {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> { Ok(0) }
    }
    impl Write for LineRecorder {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> { Ok(bytes.len()) }
        fn flush(&mut self) -> io::Result<()> { Ok(()) }
    }
    impl SerialPort for LineRecorder {
        fn name(&self) -> Option<String> { None }
        fn baud_rate(&self) -> serialport::Result<u32> { Ok(0) }
        fn data_bits(&self) -> serialport::Result<DataBits> { Ok(DataBits::Eight) }
        fn flow_control(&self) -> serialport::Result<FlowControl> { Ok(FlowControl::None) }
        fn parity(&self) -> serialport::Result<Parity> { Ok(Parity::None) }
        fn stop_bits(&self) -> serialport::Result<StopBits> { Ok(StopBits::One) }
        fn timeout(&self) -> Duration { Duration::ZERO }
        fn set_baud_rate(&mut self, _: u32) -> serialport::Result<()> { Ok(()) }
        fn set_data_bits(&mut self, _: DataBits) -> serialport::Result<()> { Ok(()) }
        fn set_flow_control(&mut self, _: FlowControl) -> serialport::Result<()> { Ok(()) }
        fn set_parity(&mut self, _: Parity) -> serialport::Result<()> { Ok(()) }
        fn set_stop_bits(&mut self, _: StopBits) -> serialport::Result<()> { Ok(()) }
        fn set_timeout(&mut self, _: Duration) -> serialport::Result<()> { Ok(()) }
        fn write_request_to_send(&mut self, level: bool) -> serialport::Result<()> {
            assert!(!level);
            self.writes.push("rts");
            Ok(())
        }
        fn write_data_terminal_ready(&mut self, level: bool) -> serialport::Result<()> {
            assert!(!level);
            self.writes.push("dtr");
            Ok(())
        }
        fn read_clear_to_send(&mut self) -> serialport::Result<bool> { Ok(false) }
        fn read_data_set_ready(&mut self) -> serialport::Result<bool> { Ok(false) }
        fn read_ring_indicator(&mut self) -> serialport::Result<bool> { Ok(false) }
        fn read_carrier_detect(&mut self) -> serialport::Result<bool> { Ok(false) }
        fn bytes_to_read(&self) -> serialport::Result<u32> { Ok(0) }
        fn bytes_to_write(&self) -> serialport::Result<u32> { Ok(0) }
        fn clear(&self, _: ClearBuffer) -> serialport::Result<()> { Ok(()) }
        fn try_clone(&self) -> serialport::Result<Box<dyn SerialPort>> { unimplemented!() }
        fn set_break(&self) -> serialport::Result<()> { Ok(()) }
        fn clear_break(&self) -> serialport::Result<()> { Ok(()) }
    }

    #[test]
    fn control_lines_drop_rts_before_dtr() {
        let mut port = LineRecorder::default();
        release_control_lines(&mut port);
        assert_eq!(port.writes, ["rts", "dtr"]);
    }

    #[cfg(not(windows))]
    #[test]
    fn opening_a_port_leaves_dtr_alone() {
        assert!(format!("{:?}", serial_port_builder("port", 4_000_000)).contains("dtr_on_open: None"));
    }
}
