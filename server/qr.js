import crypto from 'node:crypto';
import QRCode from 'qrcode';
import config from './config.js';

/** 桌面二维码内容：SRB1:<roomId>:<seatCode>:<签名>。签名防止手工构造无效码。 */
function seatCodeValue(roomId, seatCode) {
  const signature = crypto
    .createHmac('sha256', config.qrSecret)
    .update(`${roomId}:${seatCode}`)
    .digest('hex')
    .slice(0, 16);
  return `SRB1:${roomId}:${seatCode}:${signature}`;
}

function verifySeatCode(value) {
  const parts = String(value || '').trim().split(':');
  if (parts.length !== 4 || parts[0] !== 'SRB1') return { valid: false };
  const [, roomId, seatCode, signature] = parts;
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(roomId) || !/^[A-Za-z0-9_-]{1,16}$/.test(seatCode)) {
    return { valid: false };
  }
  const expected = seatCodeValue(roomId, seatCode).split(':')[3];
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { valid, roomId, seatCode };
}

async function seatQrSvg(roomId, seatCode, { size = 240 } = {}) {
  const text = seatCodeValue(roomId, seatCode);
  const svg = await QRCode.toString(text, {
    type: 'svg',
    margin: 1,
    width: size,
    color: { dark: '#172033', light: '#ffffff' },
  });
  return { svg, text };
}

export { seatCodeValue, verifySeatCode, seatQrSvg };