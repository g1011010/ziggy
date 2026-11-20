// In-app price alerts: evaluated on every refresh while the app is open.

import { store } from './store.js';

export function newAlert({ symbol, cond, price }) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    symbol,
    cond,             // 'above' | 'below'
    price,
    active: true,
    createdAt: Date.now(),
    triggeredAt: null,
    triggeredPrice: null,
  };
}

export function isHit(alert, price) {
  if (!Number.isFinite(price)) return false;
  return alert.cond === 'above' ? price >= alert.price : price <= alert.price;
}

/**
 * Check active alerts against fresh prices ({symbol: price}).
 * Fired alerts are disarmed (one-shot) and returned.
 */
export function evaluate(prices) {
  const alerts = store.getAlerts();
  const fired = [];
  for (const a of alerts) {
    if (a.active && isHit(a, prices[a.symbol])) {
      a.active = false;
      a.triggeredAt = Date.now();
      a.triggeredPrice = prices[a.symbol];
      fired.push({ ...a });
    }
  }
  if (fired.length) store.setAlerts(alerts);
  return fired;
}

export function notificationState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

export async function requestNotifications() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

/** Local notification (via the service worker where possible — required on Android). */
export async function notify(title, body) {
  try { navigator.vibrate?.([200, 100, 200]); } catch { /* ignore */ }
  if (notificationState() !== 'granted') return;
  const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: title };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return await reg.showNotification(title, opts);
    new Notification(title, opts);
  } catch { /* banner still shows */ }
}
