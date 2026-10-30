"""Compile the real Wi-Fi status/API functions against a strict FreeRTOS stub.

Input: the context, status and public API sections of pet_p4_network.c plus pet_p4_net_core.c.
Output: regression checks that a board whose network task never started (line buffer or mutex
        allocation failed, task creation failed, or init skipped) still answers USB `hello` and
        `network/*` without touching a null mutex, and that a retried init works.
Position: pytest wrapper for the pet_p4_network.c fallback path; the radio code is not compiled.
Sync: update with pet_p4_network.c/.h, pet_p4_main.c (init call) and protocol.md.
"""

from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def _between(text: str, start: str, end: str, include_end: bool = False) -> str:
    body = text.split(start, 1)[1].split(end, 1)[0]
    return start + body + (end if include_end else "")


def test_network_api_survives_a_missing_network_task(tmp_path):
    source = (ROOT / "main" / "pet_p4_network.c").read_text()
    header = (ROOT / "main" / "pet_p4_network.h").read_text()
    config_type = _between(header, "typedef struct {", "} pet_p4_network_config_t;", include_end=True)
    context = _between(source, "static const char *TAG", "static net_ctx_t s;", include_end=True)
    locking = _between(source, "static void lock(void) {", "/* ---- persistence")
    status = _between(source, "/* ---- status", "/* ---- station")
    public_api = source.split("/* ---- public API", 1)[1]
    harness = tmp_path / "network_fallback.c"
    harness.write_text(r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "pet_p4_net_core.h"
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_ERR_NO_MEM 0x101
#define ESP_ERR_INVALID_ARG 0x102
#define ESP_LOGW(tag, ...) ((void) (tag))
#define portMAX_DELAY 0xffffffffu
#define pdPASS 1
typedef struct esp_netif_obj esp_netif_t;
typedef void (*pet_p4_send_line_fn)(const char *line, void *ctx);
typedef struct { bool held; } fake_mutex_t;
typedef fake_mutex_t *SemaphoreHandle_t;
static int mutex_budget = 0, mutexes_created, mutexes_deleted;
static bool task_ok = false;
static int stores, erases;
/* Marked unused so -Werror stays quiet if a revision stops calling one of these fakes. */
#define FAKE __attribute__((unused)) static
FAKE SemaphoreHandle_t xSemaphoreCreateMutex(void) {
  if (mutex_budget == 0) return NULL;
  mutex_budget--;
  mutexes_created++;
  return calloc(1, sizeof(fake_mutex_t));
}
FAKE void vSemaphoreDelete(SemaphoreHandle_t m) {mutexes_deleted++;free(m);}
/* On the board configASSERT aborts here: the null handle is the crash this test guards against. */
FAKE int xSemaphoreTake(SemaphoreHandle_t m, uint32_t wait) {(void)wait;assert(m != NULL);assert(!m->held);m->held=true;return 1;}
FAKE int xSemaphoreGive(SemaphoreHandle_t m) {assert(m != NULL && m->held);m->held=false;return 1;}
'''
        + config_type + "\n" + context + "\n"
        + r'''
static void network_task(void *arg) {(void)arg;}
static int xTaskCreate(void (*fn)(void *), const char *name, uint32_t stack, void *arg, int prio, void *out) {
  (void)fn;(void)name;(void)stack;(void)arg;(void)prio;(void)out;return task_ok ? pdPASS : 0;
}
static uint64_t now_ms(void) {return 1;}
static uint8_t boot_try_read(void) {return 0;}
static void credentials_load(void) {s.configured = false;}
static esp_err_t credentials_store(const char *ssid, const char *password, const char *secret) {
  (void)ssid;(void)password;(void)secret;stores++;return ESP_OK;
}
static void credentials_erase(void) {erases++;}
static bool send_all(int fd, const char *data, size_t len, uint32_t budget_ms) {
  (void)fd;(void)data;(void)len;(void)budget_ms;return true;
}
'''
        + locking + "\n" + status + "\n/* ---- public API" + public_api
        + r'''
static cJSON *last_reply;
static void capture(const char *line, void *ctx) {(void)ctx;cJSON_Delete(last_reply);last_reply=cJSON_Parse(line);}
static const cJSON *reply_payload(void) {
  assert(last_reply);
  const cJSON *topic = cJSON_GetObjectItemCaseSensitive(last_reply, "topic");
  assert(cJSON_IsString(topic) && !strcmp(topic->valuestring, "network/status"));
  return cJSON_GetObjectItemCaseSensitive(last_reply, "payload");
}
static const char *field(const cJSON *object, const char *key) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(object, key);
  return cJSON_IsString(v) ? v->valuestring : "";
}
static bool flag(const cJSON *object, const char *key) {
  return cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(object, key));
}
/* What USB `bind` -> hello asks for on every connect. */
static bool hello_reports_wifi(const char **state) {
  cJSON *caps = cJSON_CreateObject();
  pet_p4_network_describe(caps);
  const cJSON *network = cJSON_GetObjectItemCaseSensitive(caps, "network");
  bool wifi = flag(network, "wifi");
  static char copy[24];
  snprintf(copy, sizeof(copy), "%s", field(network, "state"));
  *state = copy;
  cJSON_Delete(caps);
  return wifi;
}
static void expect_unavailable(const char *topic, cJSON *request) {
  assert(pet_p4_network_handle_topic(topic, request, capture, NULL, false));
  const cJSON *payload = reply_payload();
  assert(!flag(payload, "ok") && !strcmp(field(payload, "error"), "wifi_unavailable"));
  assert(!flag(payload, "supported") && !strcmp(field(payload, "requestId"), "r1"));
}
static void expect_absent(void) {
  const char *state;
  assert(!hello_reports_wifi(&state) && state[0] == '\0');
  cJSON *request = cJSON_Parse("{\"requestId\":\"r1\",\"ssid\":\"home\",\"password\":\"password1\","
    "\"secret\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}");
  expect_unavailable("network/query", request);
  expect_unavailable("network/config", request);
  expect_unavailable("network/clear", request);
  assert(stores == 0 && erases == 0);
  assert(!pet_p4_network_handle_topic("network/other", request, capture, NULL, false));
  assert(!pet_p4_network_client_ready() && !pet_p4_network_send_line("{}"));
  cJSON_Delete(request);
}
int main(void) {
  const pet_p4_network_config_t config = {.board_device_id = "p4-test", .firmware_version = "t"};
  /* pet_p4_main.c skips init when the 16 KiB line buffer cannot be allocated. */
  expect_absent();
  /* The second mutex fails: the first one is released and nothing is half-started. */
  mutex_budget = 1;
  assert(pet_p4_network_init(&config) == ESP_ERR_NO_MEM);
  assert(mutexes_created == 1 && mutexes_deleted == 1);
  expect_absent();
  /* Task creation fails: both mutexes are released, Wi-Fi is not advertised or configurable. */
  mutex_budget = 2;
  assert(pet_p4_network_init(&config) == ESP_ERR_NO_MEM);
  assert(mutexes_created == 3 && mutexes_deleted == 3);
  expect_absent();
  /* A failed init leaves no residue, so a later init starts normally. */
  mutex_budget = 2;
  task_ok = true;
  assert(pet_p4_network_init(&config) == ESP_OK);
  const char *state;
  assert(hello_reports_wifi(&state) && !strcmp(state, "unconfigured"));
  cJSON *query = cJSON_Parse("{\"requestId\":\"r2\"}");
  assert(pet_p4_network_handle_topic("network/query", query, capture, NULL, false));
  assert(flag(reply_payload(), "ok") && flag(reply_payload(), "supported"));
  assert(!strcmp(field(reply_payload(), "boardDeviceId"), "p4-test"));
  cJSON_Delete(query);
  cJSON_Delete(last_reply);
  puts("PASS Wi-Fi fallback: hello and network/* survive a missing network task; failed init leaves no residue");
  return 0;
}
''')
    exe = tmp_path / "network_fallback"
    vendor = ROOT / "tests" / "vendor" / "cjson"
    subprocess.run(
        [
            "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-Wno-error=deprecated-declarations",
            "-fsanitize=address,undefined",
            "-I", str(ROOT / "main"), "-I", str(vendor),
            str(harness), str(vendor / "cJSON.c"), str(ROOT / "main" / "pet_p4_net_core.c"),
            "-o", str(exe),
        ],
        check=True,
    )
    subprocess.run([str(exe)], check=True)
