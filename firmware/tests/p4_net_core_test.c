/*
 * [Input] Deterministic topics, credentials, nonces and clock values for the Wi-Fi link policy.
 * [Output] Assertions for the topic allowlists, credential rules, authentication message,
 *          failure lockout, reconnect backoff and disconnect-reason mapping.
 * [Pos] Native C regression executable for pet_p4_net_core.c.
 * [Sync] If this file changes, update `p4_net_core_test.py` and `pet_p4_net_core.c`.
 */

#include "pet_p4_net_core.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static void test_inbound_allowlist(void) {
  const char *allowed[] = {"ack", "bind", "system/heartbeat", "speech/text", "session/current",
                           "control/screen-page", "stats/update", "runtime/stats",
                           "state/active", "diagnostics/query", "network/query"};
  /* control/command: its audio_bridge variant would arm the microphone on the LAN link. */
  const char *refused[] = {"control/command", "asset/chunk", "asset/raw-chunk", "firmware/begin", "audio/conversation",
                           "media/begin", "widget/data", "widget/chunk", "app/snapshot",
                           "ui/conversation", "input/config", "debug/screenshot", "miniapp/event",
                           "", "statex", "acknowledge"};
  for (size_t i = 0; i < sizeof(allowed) / sizeof(allowed[0]); ++i) assert(pet_p4_net_topic_allowed(allowed[i]));
  for (size_t i = 0; i < sizeof(refused) / sizeof(refused[0]); ++i) assert(!pet_p4_net_topic_allowed(refused[i]));
  assert(!pet_p4_net_topic_allowed(NULL));
}

static void test_broadcast_allowlist_keeps_audio_and_hello_off_the_lan(void) {
  assert(pet_p4_net_broadcast_allowed("input/event"));
  assert(pet_p4_net_broadcast_allowed("input/config-state"));
  assert(pet_p4_net_broadcast_allowed("button-config-ack"));
  assert(pet_p4_net_broadcast_allowed("protocol/ack"));
  assert(pet_p4_net_broadcast_allowed("network/status"));
  assert(!pet_p4_net_broadcast_allowed("audio/chunk"));
  assert(!pet_p4_net_broadcast_allowed("audio/status"));
  assert(!pet_p4_net_broadcast_allowed("media/event"));
  assert(!pet_p4_net_broadcast_allowed("app/event"));
  assert(!pet_p4_net_broadcast_allowed("debug/lcd"));
  assert(!pet_p4_net_broadcast_allowed("firmware/ack"));
  assert(!pet_p4_net_broadcast_allowed("hello"));
  assert(!pet_p4_net_broadcast_allowed(""));
}

static void test_line_topic_extraction(void) {
  char topic[32];
  assert(pet_p4_net_line_topic("{\"topic\":\"input/event\",\"payload\":{}}", topic, sizeof(topic)));
  assert(strcmp(topic, "input/event") == 0);
  assert(!pet_p4_net_line_topic("{\"payload\":{},\"topic\":\"input/event\"}", topic, sizeof(topic)));
  assert(!pet_p4_net_line_topic("{\"topic\":\"\"}", topic, sizeof(topic)));
  assert(!pet_p4_net_line_topic("{\"topic\":\"unterminated", topic, sizeof(topic)));
  assert(!pet_p4_net_line_topic("{\"topic\":\"a\\\"b\"}", topic, sizeof(topic)));
  assert(!pet_p4_net_line_topic("{\"topic\":\"averyveryverylongtopicname\"}", topic, 8));
  assert(!pet_p4_net_line_topic("{\"type\":\"hello\"}", topic, sizeof(topic)));
  assert(!pet_p4_net_line_topic(NULL, topic, sizeof(topic)));
}

static void test_credentials(void) {
  assert(pet_p4_net_credentials_valid("Home", "correct horse"));
  assert(pet_p4_net_credentials_valid("Cafe", ""));
  assert(pet_p4_net_credentials_valid("12345678901234567890123456789012", "12345678"));
  assert(!pet_p4_net_credentials_valid("", "12345678"));
  assert(!pet_p4_net_credentials_valid("123456789012345678901234567890123", "12345678"));
  assert(!pet_p4_net_credentials_valid("Home", "short"));
  assert(!pet_p4_net_credentials_valid("Home", "1234567"));
  char sixty_three[64];
  memset(sixty_three, 'a', 63);
  sixty_three[63] = '\0';
  assert(pet_p4_net_credentials_valid("Home", sixty_three));
  char hex_psk[65];
  memset(hex_psk, 'F', 64);
  hex_psk[64] = '\0';
  assert(pet_p4_net_credentials_valid("Home", hex_psk));
  hex_psk[10] = 'g';
  assert(!pet_p4_net_credentials_valid("Home", hex_psk));
  assert(!pet_p4_net_credentials_valid(NULL, "12345678"));
  assert(!pet_p4_net_credentials_valid("Home", NULL));
}

static void test_secret_and_nonce_shapes(void) {
  char secret[65];
  memset(secret, 'a', 64);
  secret[64] = '\0';
  assert(pet_p4_net_secret_valid(secret));
  secret[63] = '\0';
  assert(!pet_p4_net_secret_valid(secret));
  assert(!pet_p4_net_secret_valid(NULL));
  assert(pet_p4_net_nonce_valid("0123456789abcdef0123456789abcdef"));
  assert(!pet_p4_net_nonce_valid("0123456789abcde"));
  assert(!pet_p4_net_nonce_valid("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"));
}

static void test_proof_message_matches_the_desktop_contract(void) {
  char message[160];
  assert(pet_p4_net_proof_message("client", "p4-aa", "dn", "cn", message, sizeof(message)));
  assert(strcmp(message, "pet-net-v1|client|p4-aa|dn|cn") == 0);
  assert(pet_p4_net_proof_message("server", "p4-aa", "dn", "cn", message, sizeof(message)));
  assert(strcmp(message, "pet-net-v1|server|p4-aa|dn|cn") == 0);
  assert(!pet_p4_net_proof_message("admin", "p4-aa", "dn", "cn", message, sizeof(message)));
  assert(!pet_p4_net_proof_message("client", "p4-aa", "dn", "cn", message, 8));
}

static void test_hex_and_constant_time_compare(void) {
  const uint8_t bytes[] = {0x00, 0x0f, 0xa5, 0xff};
  char hex[9];
  pet_p4_net_hex_encode(bytes, sizeof(bytes), hex);
  assert(strcmp(hex, "000fa5ff") == 0);
  assert(pet_p4_net_ct_equal("abc", "abc"));
  assert(!pet_p4_net_ct_equal("abc", "abd"));
  assert(!pet_p4_net_ct_equal("abc", "abcd"));
  assert(!pet_p4_net_ct_equal("", "a"));
  assert(!pet_p4_net_ct_equal(NULL, "a"));
}

static void test_auth_guard_locks_after_repeated_failures_and_recovers(void) {
  pet_p4_net_auth_guard_t guard = {0};
  uint64_t now = 1000;
  assert(!pet_p4_net_auth_locked(&guard, now));
  for (unsigned i = 0; i + 1 < PET_P4_NET_AUTH_FAILURE_LIMIT; ++i) {
    pet_p4_net_auth_failure(&guard, now);
    assert(!pet_p4_net_auth_locked(&guard, now));
  }
  pet_p4_net_auth_failure(&guard, now);
  assert(pet_p4_net_auth_locked(&guard, now));
  assert(pet_p4_net_auth_locked(&guard, now + PET_P4_NET_AUTH_LOCKOUT_MS - 1));
  assert(!pet_p4_net_auth_locked(&guard, now + PET_P4_NET_AUTH_LOCKOUT_MS));

  /* Failures spread beyond the window never accumulate into a lockout. */
  pet_p4_net_auth_guard_t slow = {0};
  now = 5000;
  for (unsigned i = 0; i < 20; ++i) {
    pet_p4_net_auth_failure(&slow, now);
    now += PET_P4_NET_AUTH_WINDOW_MS + 1;
  }
  assert(!pet_p4_net_auth_locked(&slow, now));

  pet_p4_net_auth_failure(&guard, now);
  pet_p4_net_auth_success(&guard);
  assert(guard.failures == 0 && !pet_p4_net_auth_locked(&guard, now));
}

typedef struct {
  unsigned ready;
  unsigned overflow;
  char last[32];
} feed_result_t;

static feed_result_t feed(pet_p4_net_line_t *line, const char *text) {
  feed_result_t result = {0};
  for (const char *p = text; *p; ++p) {
    pet_p4_net_line_event_t event = pet_p4_net_line_feed(line, *p);
    if (event == PET_P4_NET_LINE_READY) {
      result.ready += 1;
      snprintf(result.last, sizeof(result.last), "%s", line->buffer);
    } else if (event == PET_P4_NET_LINE_OVERFLOW) {
      result.overflow += 1;
    }
  }
  return result;
}

static void test_line_splitter_delivers_whole_lines(void) {
  char storage[8]; /* longest deliverable line: 7 bytes + NUL */
  pet_p4_net_line_t line;
  pet_p4_net_line_init(&line, storage, sizeof(storage));
  feed_result_t r = feed(&line, "ab\n");
  assert(r.ready == 1 && r.overflow == 0 && strcmp(r.last, "ab") == 0);
  r = feed(&line, "cd\r\n");
  assert(r.ready == 1 && strcmp(r.last, "cd") == 0);
  r = feed(&line, "\n\r\n\n");
  assert(r.ready == 0 && r.overflow == 0);
  r = feed(&line, "1234567\n");
  assert(r.ready == 1 && r.overflow == 0 && strcmp(r.last, "1234567") == 0);
  r = feed(&line, "x\ny\nz\n");
  assert(r.ready == 3 && strcmp(r.last, "z") == 0);
  r = feed(&line, "no newline yet");
  assert(r.ready == 0);
}

static void test_line_splitter_never_delivers_the_tail_of_an_oversized_line(void) {
  char storage[8];
  pet_p4_net_line_t line;
  pet_p4_net_line_init(&line, storage, sizeof(storage));
  /* 8 bytes do not fit; the remainder looks like a perfectly valid command. */
  feed_result_t r = feed(&line, "12345678{\"topic\":\"ack\",\"payload\":{}}\n");
  assert(r.overflow == 1 && "reported once, on the first byte that did not fit");
  assert(r.ready == 0 && "the tail must not become a line");
  r = feed(&line, "ok\n");
  assert(r.ready == 1 && r.overflow == 0 && strcmp(r.last, "ok") == 0);

  /* Overflow ended by an immediate newline, and a very long line, each report exactly once. */
  r = feed(&line, "12345678\nnext\n");
  assert(r.overflow == 1 && r.ready == 1 && strcmp(r.last, "next") == 0);
  char huge[2049];
  memset(huge, 'A', sizeof(huge) - 1);
  huge[sizeof(huge) - 1] = '\0';
  r = feed(&line, huge);
  assert(r.overflow == 1 && r.ready == 0);
  r = feed(&line, "\nfine\n");
  assert(r.overflow == 0 && r.ready == 1 && strcmp(r.last, "fine") == 0);
}

static void test_line_splitter_reset_starts_a_clean_session(void) {
  char storage[8];
  pet_p4_net_line_t line;
  pet_p4_net_line_init(&line, storage, sizeof(storage));
  feed_result_t r = feed(&line, "12345678tail");
  assert(r.overflow == 1 && line.discarding);
  pet_p4_net_line_reset(&line); /* a new client attaches mid-discard */
  r = feed(&line, "ok\n");
  assert(r.ready == 1 && strcmp(r.last, "ok") == 0);
  feed(&line, "par");
  pet_p4_net_line_reset(&line); /* a dead session's partial line is not spliced into the next */
  r = feed(&line, "tial\n");
  assert(r.ready == 1 && strcmp(r.last, "tial") == 0);
}

static void test_backoff_is_exponential_and_capped(void) {
  assert(pet_p4_net_backoff_ms(0) == 1000);
  assert(pet_p4_net_backoff_ms(1) == 2000);
  assert(pet_p4_net_backoff_ms(2) == 4000);
  assert(pet_p4_net_backoff_ms(4) == 16000);
  assert(pet_p4_net_backoff_ms(5) == 30000);
  assert(pet_p4_net_backoff_ms(1000) == 30000);
}

static void test_disconnect_reasons_map_to_stable_codes(void) {
  assert(strcmp(pet_p4_net_disconnect_error(201), "ap_not_found") == 0);
  assert(strcmp(pet_p4_net_disconnect_error(210), "ap_not_found") == 0);
  assert(strcmp(pet_p4_net_disconnect_error(15), "wrong_password") == 0);
  assert(strcmp(pet_p4_net_disconnect_error(202), "wrong_password") == 0);
  assert(strcmp(pet_p4_net_disconnect_error(204), "wrong_password") == 0);
  assert(strcmp(pet_p4_net_disconnect_error(200), "disconnected") == 0);
  assert(strcmp(pet_p4_net_disconnect_error(8), "disconnected") == 0);
  assert(strcmp(pet_p4_net_disconnect_error(0), "") == 0);
}

int main(void) {
  test_inbound_allowlist();
  test_broadcast_allowlist_keeps_audio_and_hello_off_the_lan();
  test_line_topic_extraction();
  test_credentials();
  test_secret_and_nonce_shapes();
  test_proof_message_matches_the_desktop_contract();
  test_hex_and_constant_time_compare();
  test_auth_guard_locks_after_repeated_failures_and_recovers();
  test_line_splitter_delivers_whole_lines();
  test_line_splitter_never_delivers_the_tail_of_an_oversized_line();
  test_line_splitter_reset_starts_a_clean_session();
  test_backoff_is_exponential_and_capped();
  test_disconnect_reasons_map_to_stable_codes();
  return 0;
}
