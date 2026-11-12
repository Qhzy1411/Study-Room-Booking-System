import { api, newKey, ApiError } from './api.js';
import { h, icon, openModal, toast } from './util.js';

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
    `目标座位 ${reservation.seatCode}；签到截止 ${reservation.checkinDeadlineText}。请对准桌面上的二维码。`);
  const manual = h('input', { type: 'text', placeholder: '输入桌面二维码内容', autocomplete: 'off' });
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
    setStatus('正在校验签到…');
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
          ? `本次预约已于 ${checkin?.atText || '此前'} 完成签到，无需重复扫描。`
          : `签到成功：${checkin?.atText || '已记录'}，座位 ${checkin?.seatCode || reservation.seatCode}，方式：${checkin?.method === 'admin_assist' ? '现场辅助' : '扫描桌面码'}。`,
        'ok',
      );
      stopCamera();
      if (onSuccess) onSuccess(result);
      toast(already ? '该预约已完成签到' : '签到成功，祝学习顺利');
    } catch (error) {
      const message = error instanceof ApiError ? error.message : '签到失败，请稍后重试';
      setStatus(message, 'bad');
      hint.textContent = '可核对座位后重试，或向场地管理员求助。';
    } finally {
      busy = false;
    }
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      hint.textContent = '当前浏览器无法调用相机。可在下方手动输入桌面码，或向场地管理员求助。';
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play().catch(() => {});
      hint.textContent = '将二维码置于框内，识别后自动提交。';
      if (!('BarcodeDetector' in window)) {
        hint.textContent = '当前浏览器不支持二维码识别，请手动输入桌面码，或使用 Chrome / Edge / Android 浏览器。';
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
        ? '相机权限被拒绝。可在浏览器设置中允许相机，或在下方手动输入桌面码。'
        : '无法启动相机。可手动输入桌面码，或向场地管理员求助。';
      video.remove();
    }
  }

  submitManual.addEventListener('click', () => {
    const code = manual.value.trim();
    if (!code) {
      setStatus('请先输入或扫描桌面二维码内容。', 'bad');
      return;
    }
    submitCode(code);
  });
  fillOwn.addEventListener('click', async () => {
    try {
      setStatus('正在使用本人桌面码校验签到…');
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
        ` · ${reservation.startText}—${reservation.endText}`,
      ),
      h('div', { style: { position: 'relative' } }, frame, hint),
      status,
      h('div', { class: 'field' }, h('label', {}, '相机不可用时手动输入桌面码'), manual),
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
      h('div', { class: 'notice' }, '签到窗口从预约开始时刻起，至「开始 + 宽限」与「预约结束」中较早者为止。过早、扫错座位或无效码均不会签到。'),
      h('ul', { class: 'steps' },
        h('li', {}, '确认当前时间已到预约开始，且未超过签到截止时间。'),
        h('li', {}, '核对座位号与预约记录一致，扫描该座位桌面的二维码。'),
        h('li', {}, '相机不可用时，可在扫码窗口手动输入桌面码。'),
        h('li', {}, '仍无法完成时，请联系场地管理员现场辅助签到，并说明核实方式。'),
      ),
    ),
    footer: [h('button', { class: 'btn primary', type: 'button', on: { click: () => dialog?.close() } }, '知道了')],
  });
  return dialog;
}