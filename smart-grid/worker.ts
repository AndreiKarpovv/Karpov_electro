import PocketBase from 'pocketbase';

// Обновленный URL новой базы данных
const PB_URL = 'http://pocketbase-qkf2e0wcsddiqizpqaqaaer2.176.112.158.3.sslip.io';
const pb = new PocketBase(PB_URL);

// Безопасное чтение секретов из переменных окружения Coolify
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Универсальная функция отправки уведомлений в обе платформы
async function sendSmartNotifications(message: string) {
  // --- 1. Отправка в Discord ---
  if (DISCORD_WEBHOOK_URL && !DISCORD_WEBHOOK_URL.startsWith('ВСТАВЬ')) {
    const discordPayload = {
      embeds: [{
        title: '⚡ Smart Grid Automation',
        description: message,
        color: 3066993, 
        timestamp: new Date().toISOString()
      }]
    };
    fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(discordPayload)
    }).catch(err => console.error('Discord notification failed:', err));
  }

  // --- 2. Отправка в Telegram ---
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID && !TELEGRAM_BOT_TOKEN.startsWith('ВСТАВЬ')) {
    const tgUrl = `https://api.telegram.com/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    
    const cleanMessage = message.replace(/\*/g, '');
    const tgPayload = {
      chat_id: TELEGRAM_CHAT_ID,
      text: `⚡ Smart Grid Automation\n\n${cleanMessage}`
    };

    console.log(`[Telegram Debug] Attempting to send via token prefix: ${TELEGRAM_BOT_TOKEN.substring(0, 10)}... to chat: ${TELEGRAM_CHAT_ID}`);

    fetch(tgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tgPayload)
    })
    .then(async (res) => {
      if (!res.ok) {
        const errText = await res.text();
        console.error(`🔴 [Telegram API Error] Status: ${res.status}, Body: ${errText}`);
      } else {
        console.log(`🟢 [Telegram Success] Message successfully delivered to chat ${TELEGRAM_CHAT_ID}`);
      }
    })
    .catch(err => console.error('❌ [Telegram Network Error]', err?.message || err));
  }
}

// --- Глобальные счетчики для метрик Prometheus ---
let apiRequestsSuccess = 0;
let apiRequestsFailed = 0;
let deviceCommandsTotal = 0;

// Функция для генерации структурированных JSON-логов и их автоматической отправки в Grafana Loki
function log(level: 'INFO' | 'WARNING' | 'ERROR', message: string, context: Record<string, any> = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: level,
    message: message,
    ...context
  };

  console.log(JSON.stringify(logEntry));

  const lokiUrl = 'http://loki-master:3100/loki/api/v1/push';
  const timestampNs = (BigInt(Date.now()) * 1000000n).toString();

  const payload = {
    streams: [
      {
        stream: {
          app: 'smart-grid-automation',
          environment: 'production',
          service: 'worker'
        },
        values: [
          [timestampNs, JSON.stringify(logEntry)]
        ]
      }
    ]
  };

  fetch(lokiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(response => {
    if (!response.ok) {
      console.error(`[Loki Error] Status: ${response.status}, Failed to push logs`);
    }
  }).catch(error => {
    // Не спамим жесткой ошибкой, если локально нет коннекта до Loki-контейнера сервера
    console.error('[Loki Connection Error]', error?.message || error);
  });
}

// 1. Функция стягивания цен из API Elering
async function fetchEleringPrices() {
  const start = new Date();
  start.setHours(start.getHours() - 2); 
  const end = new Date();
  end.setDate(end.getDate() + 1);

  const url = `https://dashboard.elering.ee/api/nps/price?start=${start.toISOString()}&end=${end.toISOString()}`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Elering error: ${response.statusText}`);
    
    apiRequestsSuccess++; 
    const json = (await response.json()) as { data?: { ee?: any[] } };
    return json?.data?.ee || [];
  } catch (error: any) {
    apiRequestsFailed++; 
    log('ERROR', 'Failed to fetch prices from Elering API', { error: error.message, url });
    return [];
  }
}

// Вспомогательная функция для синхронизации цен в базу
async function syncPrices() {
  log('INFO', 'Starting electricity prices synchronization');
  const prices = await fetchEleringPrices();
  
  let addedCount = 0;

  for (const item of prices) {
    const date = new Date(item.timestamp * 1000);
    date.setMinutes(0, 0, 0);
    date.setMilliseconds(0);

    const pricePerKwh = Number((item.price / 10).toFixed(2));
    
    try {
      await pb.collection('electricity_prices').create({
        timestamp: date.toISOString(),
        price: pricePerKwh
      });
      addedCount++;
    } catch (error: any) {
      if (error.status !== 400) {
        log('ERROR', 'Failed to save price record to database', { error: error.message, timestamp: date.toISOString() });
      }
    }
  }
  log('INFO', 'Electricity prices synchronization completed', { recordsAdded: addedCount, totalRetrieved: prices.length });
}

// 2. Логика управления устройствами
async function checkAutomationRules() {
  log('INFO', 'Starting automation rules verification');

  const now = new Date();
  now.setMinutes(0, 0, 0);
  now.setMilliseconds(0);
  const currentHourISO = now.toISOString();

  let currentPrice: number;

  try {
    const currentPriceRecord = await pb.collection('electricity_prices').getFirstListItem(`timestamp="${currentHourISO}"`);
    currentPrice = currentPriceRecord.price;
  } catch (e) {
    log('WARNING', 'Exact price for current hour not found, trying fallback to latest record', { expectedHour: currentHourISO });
    try {
      const latestPrices = await pb.collection('electricity_prices').getList(1, 1, {
        sort: '-timestamp'
      });
      
      const latestPriceRecord = latestPrices.items[0];

      if (latestPriceRecord) {
        currentPrice = latestPriceRecord.price;
        log('INFO', 'Fallback price successfully resolved', { fallbackPrice: currentPrice, resolvedTimestamp: latestPriceRecord.timestamp });
      } else {
        log('ERROR', 'Database of electricity prices is completely empty. Execution aborted.');
        return;
      }
    } catch (err: any) {
      log('ERROR', 'Database internal failure during fallback resolution', { error: err.message });
      return;
    }
  }

  log('INFO', 'Current electricity metrics resolved', { currentPriceCents: currentPrice, timestampISO: currentHourISO });

  let devices = [];
  let rules = [];
  try {
    devices = await pb.collection('devices').getFullList({ filter: 'is_automated = true' });
    rules = await pb.collection('automation_rules').getFullList();
  } catch (err: any) {
    log('ERROR', 'Failed to fetch automation infrastructure from database', { error: err.message });
    return;
  }

  for (const device of devices) {
    const deviceRule = rules.find(r => r.device === device.id);
    
    if (!deviceRule) {
      log('WARNING', 'Device has automation enabled but no rule configuration exists', { deviceName: device.name, deviceId: device.id });
      continue;
    }

    let shouldBeOn = false;

    const startOfDay = new Date();
    startOfDay.setHours(0,0,0,0);
    const endOfDay = new Date();
    endOfDay.setHours(23,59,59,999);

    let todaysPrices = [];
    try {
      todaysPrices = await pb.collection('electricity_prices').getFullList({
        filter: `timestamp >= "${startOfDay.toISOString()}" && timestamp <= "${endOfDay.toISOString()}"`,
        sort: 'price' 
      });
    } catch (err: any) {
      log('ERROR', 'Failed to fetch daily price range for automated calculations', { error: err.message, deviceName: device.name });
      continue;
    }

    if (deviceRule.type === 'max_price') {
      shouldBeOn = currentPrice <= deviceRule.threshold_value;
    } 
    else if (deviceRule.type === 'cheapest_hours') {
      const hoursCount = deviceRule.threshold_value;
      const cheapestRecords = todaysPrices.slice(0, hoursCount);
      shouldBeOn = cheapestRecords.some(r => {
        const rDate = new Date(r.timestamp);
        rDate.setMinutes(0, 0, 0);
        rDate.setMilliseconds(0);
        return rDate.toISOString() === currentHourISO;
      });
    }
    else if (deviceRule.type === 'smart_saving') {
      if (todaysPrices.length > 0) {
        const totalSum = todaysPrices.reduce((sum, r) => sum + r.price, 0);
        const avgPrice = totalSum / todaysPrices.length;
        
        const discountPercent = deviceRule.threshold_value;
        const targetPrice = avgPrice * (1 - discountPercent / 100);

        shouldBeOn = currentPrice <= targetPrice;
        
        log('INFO', 'Smart saving internal math calculation', {
          deviceName: device.name,
          dailyAveragePrice: Number(avgPrice.toFixed(2)),
          targetPriceThreshold: Number(targetPrice.toFixed(2)),
          currentPrice: currentPrice
        });
      }
    }

    if (device.status !== shouldBeOn) {
      try {
        await pb.collection('devices').update(device.id, { status: shouldBeOn });
        deviceCommandsTotal++; 

        const stateText = shouldBeOn ? 'ВКЛЮЧЕН 🟢' : 'ВЫКЛЮЧЕН 🔴';
        const notificationMessage = `Устройство *${device.name}* было автоматически *${stateText}*.\nТекущая биржевая цена: *${currentPrice}* центов/кВтч.`;
        await sendSmartNotifications(notificationMessage);

        log('INFO', 'Device power relay state altered by automation engine', { 
          deviceName: device.name, 
          previousState: device.status, 
          newState: shouldBeOn,
          triggeredByRule: deviceRule.type
        });
      } catch (err: any) {
        log('ERROR', 'Failed to commit device relay state change to database', { error: err.message, deviceName: device.name });
      }
    } else {
      log('INFO', 'Device power state remains unchanged', { deviceName: device.name, currentState: device.status });
    }
  }

  // --- Фиксация потребления в device_usage ---
  for (const device of devices) {
    if (device.status === true) {
      const powerKw = (device.power_limit || 1000) / 1000; 
      const hoursElapsed = 15 / 3600; 
      const kwhConsumed = Number((powerKw * hoursElapsed).toFixed(5));

      try {
        await pb.collection('device_usage').create({
          device_usage: device.id,
          kwh_consumed: kwhConsumed,
          price_at_that_time: currentPrice,
          timestamp: new Date().toISOString()
        });
        
        log('INFO', 'Consumption log registered for dashboard reports', {
          deviceName: device.name,
          kwh: kwhConsumed,
          appliedPrice: currentPrice
        });
      } catch (err: any) {
        log('ERROR', 'Failed to write usage snapshot to device_usage collection', { error: err.message, details: err.data });
      }
    }
  }

  log('INFO', 'Automation rules verification completed');
}

// 3. Расчет сэкономленных средств (Säästuaruanne)
async function calculateSavings(fixedRate: number = 0.15) {
  try {
    const logs = await pb.collection('device_usage').getFullList({
      sort: '-created'
    });
    
    let totalPaid = 0; 
    let hypotheticalFixedCost = 0; 

    logs.forEach(item => {
      const realPriceInEuro = item.price_at_that_time / 100;
      totalPaid += item.kwh_consumed * realPriceInEuro;
      hypotheticalFixedCost += item.kwh_consumed * fixedRate;
    });
    
    const savedMoney = hypotheticalFixedCost - totalPaid;

    const safetyPercentage = savedMoney > 0 && hypotheticalFixedCost > 0 
      ? Number(((savedMoney / hypotheticalFixedCost) * 100).toFixed(1)) 
      : 0;

    return {
      saved: Number(savedMoney.toFixed(2)),
      percentage: safetyPercentage,
      totalRealCost: Number(totalPaid.toFixed(2)),
      totalFixedCost: Number(hypotheticalFixedCost.toFixed(2)),
      recordsAnalyzed: logs.length
    };
  } catch (error: any) {
    log('ERROR', 'Failed to execute savings reporting matrix calculations', { error: error.message });
    return { saved: 0, percentage: 0, totalRealCost: 0, totalFixedCost: 0, recordsAnalyzed: 0 };
  }
}

// 4. Главный цикл воркера
async function main() {
  try {
    // Авторизуемся как системный пользователь-воркер
    await pb.collection('users').authWithPassword('worker@smartgrid.local', 'SuperSecretWorker2026');
  } catch (e: any) {
    log('ERROR', 'Worker authentication sequence failed. Termination initiated.', { error: e.message });
    return;
  }

  await syncPrices();
  await checkAutomationRules();

  setInterval(syncPrices, 30 * 60 * 1000);
  setInterval(checkAutomationRules, 15 * 1000);

  setInterval(async () => {
    log('INFO', 'Recalculating global savings report for dashboard');
    const report = await calculateSavings(0.15); 
    
    log('INFO', 'System performance metrics snapshot', {
      metric_api_requests_success: apiRequestsSuccess,
      metric_api_requests_failed: apiRequestsFailed,
      metric_device_commands_total: deviceCommandsTotal,
      metric_node_memory_rss_bytes: process.memoryUsage().rss
    });
    
    try {
      const records = await pb.collection('savings_report').getList(1, 1);
      
      const reportData = {
        saved: report.saved,
        percentage: report.percentage,
        total_real_cost: report.totalRealCost,
        total_fixed_cost: report.totalFixedCost,
        records_analyzed: report.recordsAnalyzed
      };

      const firstItem = records.items[0];

      if (firstItem) {
        await pb.collection('savings_report').update(firstItem.id, reportData);
      } else {
        await pb.collection('savings_report').create(reportData);
      }
      log('INFO', 'Global savings report successfully updated in database', reportData);
    } catch (err: any) {
      log('ERROR', 'Failed to commit calculated savings report to database', { error: err.message });
    }
  }, 15 * 1000);

  // ИСПРАВЛЕНО: Безопасный запуск сервера Prometheus метрик только в среде Bun (Coolify/Школа)
  // На домашней Node.js ветка else предотвратит ReferenceError и падение скрипта
  if (typeof (globalThis as any).Bun !== 'undefined') {
    (globalThis as any).Bun.serve({
      port: 9100,
      fetch(req: any) {
        const url = new URL(req.url);
        if (url.pathname === "/metrics") {
          const mem = process.memoryUsage();
          
          const metricsStr = [
            `# HELP api_requests_total Total number of Elering API requests.`,
            `# TYPE api_requests_total counter`,
            `api_requests_total{status="success"} ${apiRequestsSuccess}`,
            `api_requests_total{status="failed"} ${apiRequestsFailed}`,
            
            `# HELP device_commands_total Total number of automated device state changes.`,
            `# TYPE device_commands_total counter`,
            `device_commands_total ${deviceCommandsTotal}`,
            
            `# HELP node_memory_rss_bytes Resident set size of the process memory.`,
            `# TYPE node_memory_rss_bytes gauge`,
            `node_memory_rss_bytes ${mem.rss}`
          ].join("\n") + "\n";

          return new Response(metricsStr, {
            headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    log('INFO', 'Prometheus metrics exporter started on port 9100 at /metrics (Bun Environment Enabled)');
  } else {
    console.log('--- Running in Node.js mode (Prometheus metrics server disabled locally) ---');
  }
}

if (process.argv[1] && !process.argv[1].includes('.test.')) {
  main();
}

// Безопасное прокидывание функции для тестов через глобальный скоуп без ESM-экспорта
(globalThis as any).calculateSavings = calculateSavings;