import config from './config.js';
import { ensureDemoOpenPlans } from './seed.js';
import { processDue } from './services/reservations.js';
import { deliverPending, sendDueReminders } from './services/notifications.js';

let timer = null;

/** 后台任务：补齐演示排班、处理到期状态与投递站内通知。 */
function startScheduler() {
  const tick = () => {
    try {
      ensureDemoOpenPlans();
      const handled = processDue();
      sendDueReminders();
      const delivery = deliverPending();
      if (handled > 0 || delivery.processed > 0) {
        console.log(
          `[tick] 到期处理 ${handled} 条，通知投递 ${delivery.sent}/${delivery.processed}`,
        );
      }
    } catch (err) {
      console.error('[tick] 后台任务失败：', err);
    }
  };
  tick();
  timer = setInterval(tick, config.tickIntervalMs);
  timer.unref?.();
  return timer;
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export { startScheduler, stopScheduler };
