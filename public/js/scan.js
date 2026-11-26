import { api, newKey, ApiError } from './api.js';
import { h, openModal, timeRangeText } from './util.js';

/**
 * 桌面二维码签到对话框。
 * 优先调用摄像头识别二维码；相机不可用或浏览器不支持时，可手动输入桌面码，
 * 服务端仍按本人预约、目标座位与签到窗口校验。
 */
export function openScanDialog({ reservation, onSuccess = null }) {
  let stream = null;
  let timer = null;
  let stopped = false;
  let busy = false;

  const video = h('video', { autoplay: true, playsInline: true, muted: true });
  const hint = h('div', { class: 'scan-hint' }, '正在请求相机权限…');
  const frame = h('div', { class: 'scan-frame' }, video,
    h('div', { class: 'scan-corner tl' }), h('div', { class: 'scan-corner tr' }),
    h('div', { class: 'scan-corner bl' }), h('div', { class: 'scan-corner br' }),
  );
  const status = h('div', { class: 'scan-status', role: 'status', 'aria-live': 'polite' },
    `签到截止：${reservation.checkinDeadlineText}`);
  const manual = h('input', { type: 'text', placeholder: '输入桌面码', autocomplete: 'off' });
  const submitManual = h('button', { class: 'btn primary', type: 'button' }, '提交桌面码');
  const fillOwn = h('button', { class: 'btn ghost sm', type: 'button' }, '使用本人桌面码签到');

  function setStatus(text, tone = '') {
    status.className = `scan-status ${tone}`;
    status.textContent = text;
  }

  function stopCamera() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    video.srcObject = null;
  }

  async function submitCode(code) {
    if (busy || !code) return;
    busy = true;
    setStatus('正在签到…');
    try {
      const result = await api.post(
        `/reservations/${reservation.id}/checkin`,
        { code },
        { idempotencyKey: newKey() },
      );
      const checkin = result.checkin;
      const already = result.alreadyCheckedIn;
      setStatus(
        already
          ? `已签到${checkin?.atText ? `：${checkin.atText}` : ''}`
          : `签到成功：${checkin?.atText || '已记录'}，座位 ${checkin?.seatCode || reservation.seatCode}，方式：${checkin?.method === 'admin_assist' ? '现场辅助' : '扫描桌面码'}。`,
        'ok',
      );
      stopCamera();
      if (onSuccess) onSuccess(result);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : '签到失败，请稍后重试';
      setStatus(message, 'bad');
    } finally {
      busy = false;
    }
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      hint.textContent = '相机不可用，请手动输入桌面码。';
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play().catch(() => {});
      hint.textContent = '请将桌面二维码对准取景框。';
      if (!('BarcodeDetector' in window)) {
        hint.textContent = '浏览器不支持扫码，请手动输入桌面码。';
        return;
      }
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      timer = setInterval(async () => {
        if (stopped || busy || video.readyState < 2) return;
        try {
          const codes = await detector.detect(video);
          if (codes && codes.length) {
            const raw = codes[0].rawValue;
            manual.value = raw;
            await submitCode(raw);
          }
        } catch {
          /* 单帧识别失败继续尝试 */
        }
      }, 300);
    } catch (error) {
      const denied = error?.name === 'NotAllowedError';
      hint.textContent = denied
        ? '相机权限未开启，请手动输入桌面码。'
        : '无法启动相机，请手动输入桌面码。';
      video.remove();
    }
  }

  submitManual.addEventListener('click', () => {
    const code = manual.value.trim();
    if (!code) {
      setStatus('请输入桌面码', 'bad');
      return;
    }
    submitCode(code);
  });
  fillOwn.addEventListener('click', async () => {
    try {
      setStatus('正在获取桌面码…');
      const data = await api.get(`/reservations/${reservation.id}/desk-code`);
      await submitCode(data.code);
    } catch (error) {
      setStatus(error.message || '无法获取桌面码', 'bad');
    }
  });

  const dialog = openModal({
    title: '扫码签到',
    body: h('div', { class: 'scanner' },
      h('div', { class: 'notice' },
        h('strong', {}, `${reservation.roomName} ${reservation.seatCode} 座位`),
        ` · ${timeRangeText(reservation.startText, reservation.endText)}`,
      ),
      h('div', { style: { position: 'relative' } }, frame, hint),
      status,
      h('div', { class: 'field' }, h('label', {}, '手动签到'), manual),
      h('div', { class: 'row' },
        submitManual,
        fillOwn,
      ),
    ),
    footer: [h('button', { class: 'btn', type: 'button', on: { click: () => dialog.close() } }, '关闭')],
    onClose: stopCamera,
  });
  startCamera();
  return dialog;
}

export function openCheckinHelp() {
  let dialog = null;
  dialog = openModal({
    title: '签到遇到问题',
    body: h('div', { class: 'stack' },
      h('ul', { class: 'steps' },
        h('li', {}, '在预约开始后、签到截止前扫码。'),
        h('li', {}, '扫描预约座位上的二维码。'),
        h('li', {}, '相机不可用时，手动输入桌面码。'),
        h('li', {}, '仍无法签到时，请联系场地管理员。'),
      ),
    ),
    footer: [h('button', { class: 'btn primary', type: 'button', on: { click: () => dialog?.close() } }, '知道了')],
  });
  return dialog;
}
