/**
 * [Input] useDeviceContext for appearances/agentAppearanceMap/agentOptions/currentDisplay/verified USB status/cancellable appearanceSync/refreshAppearances/applyDesktopPet/saveAgentAppearance; useToast for notices.
 * [Output] Dashboard "Agent与形象" matrix: all supported local Agent channels with unavailable client/CLI rows kept visible, detected channels offering independent appearance selection and USB-only follow switching, non-blocking inline USB appearance-sync progress with a real abort action, and preloading followed Agents' new pets before saving their assignments while preserving the latest device focus.
 * [Pos] component node in pc/src/dashboard
 * [Sync] If this file changes, update `pc/src/dashboard/.folder.md`.
 */

import React, { useCallback, useMemo, useState } from "react";
import {
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Braces,
  Code,
  Loader,
  Terminal,
  UploadCloud,
  X,
  Zap,
} from "lucide-react";
import {
  appearanceById,
  channelLabelForId,
} from "../lib/agent-appearance-config.js";
import { BUILTIN_TERRIER_APPEARANCE_ID } from "../lib/builtin-appearances.js";
import {
  APPEARANCE_SYNC_CANCELLED_MESSAGE,
  APPEARANCE_CHANGE_USB_REQUIRED_MESSAGE,
  CHANNEL_SWITCH_DEVICE_REQUIRED_MESSAGE,
} from "../lib/desktop-pet-assignment.js";
import AppearancePreview from "../AppearancePreview.jsx";
import { resolveDashboardPreviewMedia } from "../lib/appearance-preview.js";
import { useAgentFocusContext } from "./AgentFocusContext.js";
import { useDeviceContext } from "../shell/DeviceContext.jsx";
import Button from "../shell/Button.jsx";
import { useToast } from "../shell/ToastStack.jsx";

const AGENT_ICONS = {
  "claude-code": Code,
  codex: Terminal,
  openclaw: Zap,
  mimocode: Braces,
  workbuddy: Code,
};

function appearanceKindLabel(appearance) {
  if (appearance?.type === "codex-import") return "Codex pet";
  if (appearance?.type === "builtin") return "内置";
  return "自定义";
}

function normalizeSyncProgress(progress = {}) {
  const bytesSent = Number(progress.bytesSent || 0);
  const bytesTotal = Number(progress.bytesTotal || 0);
  const rawPercent = Number(progress.percent);
  const percent = Number.isFinite(rawPercent)
    ? rawPercent
    : bytesTotal > 0
      ? Math.round((bytesSent / bytesTotal) * 100)
      : 0;
  return {
    text: progress.text || "正在通过 USB 下发形象素材...",
    // Follow-only switches reuse the device's current appearance: nothing is
    // transferred, so there is no byte progress and nothing to abort.
    followOnly: progress.followOnly === true,
    indeterminate: progress.followOnly === true || progress.indeterminate === true,
    currentFile: Number(progress.currentFile || 0),
    totalFiles: Number(progress.totalFiles || 0),
    bytesSent,
    bytesTotal,
    percent: Math.max(0, Math.min(100, Math.round(percent))),
  };
}

export default function ChannelMatrixCard() {
  const {
    appearances,
    agentAppearanceMap,
    agentOptions,
    currentDisplay,
    usb,
    appearanceSync,
    refreshAppearances,
    applyDesktopPet,
    cancelAppearanceSync,
    saveAgentAppearance,
    deviceFollowAgents,
    setDeviceFollowAgent,
    petFollowMode,
    setPetFollowMode,
  } = useDeviceContext();
  const focus = useAgentFocusContext();
  const { push } = useToast();

  const [followBusyId, setFollowBusyId] = useState("");
  const [pickerState, setPickerState] = useState(null); // { agentId }
  const [pendingFollow, setPendingFollow] = useState(null); // { agentId, appearance }
  const syncing = appearanceSync?.pending === true || followBusyId !== "";
  const syncProgress = appearanceSync?.progress
    ? normalizeSyncProgress(appearanceSync.progress)
    : null;

  const visibleAgents = useMemo(() => agentOptions.filter((agent) => agent?.id), [agentOptions]);
  const activeAgentId = currentDisplay.agentId;

  const appearanceForAgent = useCallback(
    (agentId) => {
      const appearanceId = agentAppearanceMap[agentId] || BUILTIN_TERRIER_APPEARANCE_ID;
      return appearanceById(appearances, appearanceId) || appearanceById(appearances, BUILTIN_TERRIER_APPEARANCE_ID) || appearances[0] || null;
    },
    [agentAppearanceMap, appearances],
  );

  const closePicker = useCallback(() => setPickerState(null), []);

  const openPicker = useCallback((agentId) => {
    setPickerState({ agentId });
    refreshAppearances().catch((error) => {
      console.warn("[ChannelMatrixCard] appearance refresh failed", error);
    });
  }, [refreshAppearances]);

  const handleConfirmAppearance = useCallback(async (agentId, appearance) => {
    if (!agentId || !appearance?.id) return;
    const isFollowed = agentId === activeAgentId;
    const alsoFollowed = !isFollowed && (deviceFollowAgents || []).includes(agentId);
    closePicker();

    try {
      if (!isFollowed) {
        if (alsoFollowed) {
          if (!usb?.connected || usb.transport === "wifi") {
            push({ tone: "warning", title: "更换同时跟随的桌宠需要 USB 连接", message: "请先连接 USB，再更换该 Agent 的形象。" });
            return;
          }
          setFollowBusyId(agentId);
          const outcome = await focus.preloadAppearance({ appearanceId: appearance.id, boardDeviceId: usb.boardDeviceId });
          if (outcome.ignored) {
            push({ tone: "info", title: "桌宠槽已满，已保留原形象", message: "新形象未存入设备，也未更改该 Agent 的形象选择。" });
            return;
          }
          if (!outcome.ok) throw new Error(outcome.error || "无法把桌宠存入设备");
        }
        saveAgentAppearance(agentId, appearance.id);
        push({
          tone: "success",
          title: `已为 ${channelLabelForId(agentOptions, agentId)} ${alsoFollowed ? "同步" : "保存"}「${appearance.name}」`,
        });
        return;
      }

      const { notice } = await applyDesktopPet(agentId, appearance, {
        initialProgress: {
          text: `准备下发「${appearance.name}」到设备端...`,
          percent: 0,
          indeterminate: true,
        },
      });
      push({ tone: "success", title: notice || `已同步「${appearance.name}」到设备端` });
    } catch (err) {
      const msg = err?.message || String(err);
      const cancelled = msg === APPEARANCE_SYNC_CANCELLED_MESSAGE;
      const tone =
        cancelled || msg === APPEARANCE_CHANGE_USB_REQUIRED_MESSAGE ? "warning" : "error";
      push({
        tone,
        title: cancelled ? "形象传输已中断" : "更换形象失败",
        message: cancelled ? "设备继续保留原形象。" : msg,
      });
    } finally {
      if (alsoFollowed) setFollowBusyId("");
    }
  }, [activeAgentId, agentOptions, applyDesktopPet, closePicker, deviceFollowAgents, focus.preloadAppearance, push, saveAgentAppearance, usb]);

  const requestFollow = useCallback((agentId) => {
    const appearance = appearanceForAgent(agentId);
    if (!appearance) return;
    setPendingFollow({ agentId, appearance });
  }, [appearanceForAgent]);

  const confirmFollow = useCallback(async () => {
    if (!pendingFollow) return;
    const { agentId, appearance } = pendingFollow;
    setPendingFollow(null);
    const followOnly = appearance.id === currentDisplay.appearance?.id;
    try {
      const { notice } = await applyDesktopPet(agentId, appearance, {
        initialProgress: followOnly
          ? {
            text: `沿用「${appearance.name}」，正在把设备跟随切换到 ${channelLabelForId(agentOptions, agentId)}…`,
            followOnly: true,
          }
          : {
            text: `准备下发「${appearance.name}」并切换跟随...`,
            percent: 0,
            indeterminate: true,
          },
      });
      push({ tone: "success", title: notice || `已跟随 ${channelLabelForId(agentOptions, agentId)}` });
    } catch (err) {
      const msg = err?.message || String(err);
      const cancelled = msg === APPEARANCE_SYNC_CANCELLED_MESSAGE;
      const tone =
        cancelled ||
        msg === APPEARANCE_CHANGE_USB_REQUIRED_MESSAGE ||
        msg === CHANNEL_SWITCH_DEVICE_REQUIRED_MESSAGE
          ? "warning"
          : "error";
      push({
        tone,
        title: cancelled ? "形象传输已中断" : "切换跟随失败",
        message: cancelled ? "设备继续保留原形象和跟随主体。" : msg,
      });
    }
  }, [agentOptions, applyDesktopPet, currentDisplay.appearance?.id, pendingFollow, push]);

  // Opting an Agent in stores its pet on the board first, so the focus can switch to it later without a
  // transfer. That needs USB; opting out only changes the follow set.
  const handleToggleDeviceFollow = useCallback(async (agent, checked) => {
    if (checked && (!usb?.connected || usb.transport === "wifi")) {
      push({
        tone: "warning",
        title: "加入同时跟随需要 USB 连接",
        message: "要先把该 Agent 的桌宠存入设备，之后才能在 USB 或 WiFi 下自动切换。",
      });
      return;
    }
    const appearance = checked ? appearanceForAgent(agent.id) : null;
    if (checked && !appearance) return;
    setFollowBusyId(agent.id);
    try {
      if (checked) {
        const outcome = await focus.preloadAppearance({ appearanceId: appearance.id, boardDeviceId: usb.boardDeviceId });
        if (outcome.ignored) {
          push({ tone: "info", title: "桌宠槽已满，已保留现有 Agent", message: "新形象未加入同时跟随。" });
          return;
        }
        if (!outcome.ok) {
          push({ tone: "error", title: "无法把桌宠存入设备", message: outcome.error });
          return;
        }
      }
      await setDeviceFollowAgent(agent.id, checked);
      if (checked) push({
        tone: "success",
        title: `已把「${appearance.name}」存入设备`,
        message: `${agent.label} 比其他 Agent 更早活跃时，设备会自动切换到它的桌宠。`,
      });
    } catch (error) {
      push({ tone: "error", title: "更新同时跟随失败", message: error?.message || String(error) });
    } finally {
      setFollowBusyId("");
    }
  }, [appearanceForAgent, focus.preloadAppearance, push, setDeviceFollowAgent, usb]);

  const handleCancelAppearanceSync = useCallback(async () => {
    try {
      await cancelAppearanceSync();
    } catch (error) {
      push({
        tone: "error",
        title: "无法中断形象传输",
        message: error?.message || String(error),
      });
    }
  }, [cancelAppearanceSync, push]);

  return (
    <div className="channel-matrix">
      {syncProgress && (
        <div className="channel-matrix-sync" aria-live="polite">
          <div className="channel-matrix-sync__copy">
            <UploadCloud size={15} />
            <div>
              <strong>{syncProgress.followOnly ? "正在切换跟随" : "正在切换形象"}</strong>
              <span>{syncProgress.text}</span>
            </div>
          </div>
          <div className="channel-matrix-sync__meter">
            <span>{syncProgress.indeterminate ? "准备中" : `${syncProgress.percent}%`}</span>
            <div
              className={`channel-matrix-sync__bar${syncProgress.indeterminate ? " is-indeterminate" : ""}`}
              role="progressbar"
              aria-label={syncProgress.followOnly ? "设备跟随切换进度" : "形象素材下发进度"}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={syncProgress.indeterminate ? undefined : syncProgress.percent}
            >
              <span style={{ "--sync-progress": `${syncProgress.percent}%` }} />
            </div>
          </div>
          {!syncProgress.followOnly && <Button
            className="channel-matrix-sync__cancel"
            variant="danger"
            size="small"
            loading={appearanceSync?.cancelling === true}
            loadingLabel="正在中断…"
            onClick={handleCancelAppearanceSync}
            aria-label="中断 USB 形象传输"
          >
            <X size={14} />
            中断传输
          </Button>}
        </div>
      )}

      {focus.followAgentIds.length > 1 && (
        <div className="channel-matrix__focus" aria-live="polite">
          <div className="channel-matrix__focus-copy">
            <strong>设备当前显示：{channelLabelForId(agentOptions, focus.focusAgentId)}</strong>
            <span>
              {focus.mode === "pinned" ? "已手动固定" : "自动：最先活跃的 Agent 优先，多个同时活跃时不抢占"}
            </span>
          </div>
          <div className="channel-matrix__focus-actions">
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => focus.step(-1)}
              aria-label="切换到上一个 Agent"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => focus.step(1)}
              aria-label="切换到下一个 Agent"
            >
              <ChevronRight size={14} />
            </button>
            {focus.mode === "pinned" && (
              <button type="button" className="btn-secondary btn-sm" onClick={focus.release}>
                恢复自动
              </button>
            )}
          </div>
          <label className="channel-matrix__resident">
            <input
              type="checkbox"
              checked={petFollowMode === "resident"}
              onChange={(event) => setPetFollowMode(event.target.checked ? "resident" : "follow")}
            />
            桌宠常驻（切换 Agent 时不换形象）
          </label>
        </div>
      )}

      {visibleAgents.length === 0 ? (
        <div className="channel-matrix__empty">暂时无法读取本机 Agent 列表。</div>
      ) : (
        <div className="channel-matrix__rows">
          {visibleAgents.map((agent) => {
            const Icon = AGENT_ICONS[agent.id] || Code;
            const appearance = appearanceForAgent(agent.id);
            const isFollowed = activeAgentId === agent.id;
            const isDetected = agent.detected === true;
            const alsoFollowed = (deviceFollowAgents || []).includes(agent.id);
            const isFocus = focus.followAgentIds.length > 1 && focus.focusAgentId === agent.id;
            return (
              <article
                key={agent.id}
                className={`channel-row${isFollowed ? " is-active" : ""}${isFocus ? " is-focus" : ""}${isDetected ? "" : " is-undetected"}`}
                aria-current={isFollowed ? "true" : undefined}
              >
                <div className="channel-row__channel">
                  <span className="channel-row__icon"><Icon size={16} /></span>
                  <div className="channel-row__label">
                    <strong>{agent.label}</strong>
                    <span className="channel-row__status" title={agent.detail || undefined}>
                      {isDetected ? "已检测" : "未检测到客户端或 CLI"}
                      {isFocus ? " · 设备正在显示" : ""}
                    </span>
                  </div>
                </div>

                <div className="channel-row__formosa">
                  <div className="channel-row__thumb-wrap">
                    <AppearancePreview
                      media={resolveDashboardPreviewMedia(appearance)}
                      className="channel-row__thumb"
                      emptyClassName="channel-row__thumb channel-row__thumb--empty"
                      playing={false}
                    />
                  </div>
                  <div className="channel-row__formosa-meta">
                    <div className="channel-row__formosa-title">
                      <strong>{appearance?.name || "西高地小狗"}</strong>
                      <button
                        type="button"
                        className="btn-secondary btn-sm channel-row__change-inline"
                        onClick={() => openPicker(agent.id)}
                        disabled={syncing || !isDetected}
                        title={!isDetected ? "安装对应客户端或 CLI 后重新扫描" : ""}
                      >
                        <ChevronDown size={14} /> 更换形象
                      </button>
                    </div>
                    <span>{appearanceKindLabel(appearance)}</span>
                  </div>
                </div>

                <div className="channel-row__follow">
                  {isFollowed ? (
                    <span className="channel-row__follow-current">已跟随</span>
                  ) : !isDetected ? (
                    <span
                      className="channel-row__unavailable"
                      title="安装对应客户端或 CLI 后重新扫描"
                    >
                      不可用
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn-primary btn-sm channel-row__follow-button"
                      onClick={() => requestFollow(agent.id)}
                      disabled={syncing || !usb?.connected}
                      title={!usb?.connected ? "连接 USB 后才能切换跟随" : ""}
                    >
                      跟随
                    </button>
                  )}
                  {!isFollowed && isDetected && (
                    <label
                      className="channel-row__also-follow"
                      title="让设备同时跟随这个 Agent：它的桌宠会存入设备，活跃时自动切换"
                    >
                      <input
                        type="checkbox"
                        checked={alsoFollowed}
                        disabled={syncing || followBusyId !== ""}
                        onChange={(event) => handleToggleDeviceFollow(agent, event.target.checked)}
                      />
                      {followBusyId === agent.id ? "存入设备…" : "同时跟随"}
                    </label>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {pickerState && (
        <AgentAppearancePickerModal
          appearances={appearances}
          agentLabel={channelLabelForId(agentOptions, pickerState.agentId)}
          selectedAppearanceId={(agentAppearanceMap[pickerState.agentId] || BUILTIN_TERRIER_APPEARANCE_ID)}
          isFollowed={pickerState.agentId === activeAgentId || (deviceFollowAgents || []).includes(pickerState.agentId)}
          syncing={syncing}
          onClose={closePicker}
          onConfirm={(appearance) => handleConfirmAppearance(pickerState.agentId, appearance)}
        />
      )}

      {pendingFollow && (
        <FollowAgentConfirmModal
          currentLabel={channelLabelForId(agentOptions, activeAgentId)}
          nextLabel={channelLabelForId(agentOptions, pendingFollow.agentId)}
          appearanceName={pendingFollow.appearance?.name || "西高地小狗"}
          reusesCurrentAppearance={pendingFollow.appearance?.id === currentDisplay.appearance?.id}
          syncing={syncing}
          onCancel={() => setPendingFollow(null)}
          onConfirm={confirmFollow}
        />
      )}
    </div>
  );
}

function AgentAppearancePickerModal({
  appearances,
  agentLabel,
  selectedAppearanceId,
  isFollowed,
  syncing,
  onClose,
  onConfirm,
}) {
  const [selectedId, setSelectedId] = useState(selectedAppearanceId || BUILTIN_TERRIER_APPEARANCE_ID);
  const selected = appearanceById(appearances, selectedId);
  const canConfirm = Boolean(selected) && !syncing;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-card--formosa-picker" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3 className="modal-title">更换形象</h3>
            <div className="modal-subtitle">
              {isFollowed
                ? `确认后会把 ${agentLabel} 的新形象实时同步到设备端。`
                : `确认后只保存 ${agentLabel} 的形象选择，不会立即同步设备端。`}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭" disabled={syncing}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="formosa-picker__grid">
            {appearances.map((row) => (
              <button
                type="button"
                key={row.id}
                className={`formosa-picker__option${selectedId === row.id ? " is-selected" : ""}`}
                onClick={() => setSelectedId(row.id)}
                disabled={syncing}
              >
                <div className="formosa-picker__stage" aria-hidden="true">
                <AppearancePreview
                  media={resolveDashboardPreviewMedia(row)}
                  className="formosa-picker__media"
                  emptyClassName="formosa-picker__media formosa-picker__media--empty"
                  playing={false}
                />
                </div>
                <div className="formosa-picker__copy">
                  <strong>{row.name}</strong>
                  <span>{appearanceKindLabel(row)}</span>
                </div>
                {selectedId === row.id && <CheckCircle className="formosa-picker__check" size={16} />}
              </button>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" type="button" onClick={onClose} disabled={syncing}>
            取消
          </button>
          <button
            className="btn-primary"
            type="button"
            onClick={() => selected && onConfirm(selected)}
            disabled={!canConfirm}
          >
            {syncing ? <Loader size={14} className="spin" /> : <UploadCloud size={14} />}
            确认
          </button>
        </div>
      </div>
    </div>
  );
}

function FollowAgentConfirmModal({
  currentLabel,
  nextLabel,
  appearanceName,
  reusesCurrentAppearance,
  syncing,
  onCancel,
  onConfirm,
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card channel-switch-confirm-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3 className="modal-title">切换跟随 Agent</h3>
            <div className="modal-subtitle">设备端同一时间只展示一个 Agent 的实时状态。</div>
          </div>
          <button className="icon-btn" onClick={onCancel} aria-label="关闭" disabled={syncing}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body channel-switch-confirm-modal__body">
          <div className="message-banner message-banner--muted channel-switch-confirm-modal__message">
            {reusesCurrentAppearance
              ? <>将设备端跟随的 Agent 从 {currentLabel || "当前 Agent"} 切换为 {nextLabel || "目标 Agent"}，沿用设备当前的「{appearanceName}」，无需重新传输素材。</>
              : <>将设备端跟随的 Agent 从 {currentLabel || "当前 Agent"} 切换为 {nextLabel || "目标 Agent"}，并同步「{appearanceName}」到设备端展示。</>}
          </div>
        </div>
        <div className="channel-switch-confirm-modal__actions">
          <button className="btn-secondary" type="button" onClick={onCancel} disabled={syncing}>
            取消
          </button>
          <button className="btn-primary" type="button" onClick={onConfirm} disabled={syncing}>
            {syncing && <Loader size={14} className="spin" />}
            确认跟随
          </button>
        </div>
      </div>
    </div>
  );
}
