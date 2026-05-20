import PocketBase from 'pocketbase';

const PB_URL = 'http://pocketbase-scrrou020syoy2qbfjbl1bsx.176.112.158.3.sslip.io';
const pb = new PocketBase(PB_URL);

// Функция для генерации структурированных JSON-логов и их автоматической отправки в Grafana Loki
function log(level: 'INFO' | 'WARNING' | 'ERROR', message: string, context: Record<string, any> = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: level,
    message: message,
    ...context
  };

  // 1. Выводим строго в формате JSON одной строкой, как требует ТЗ (для терминала и Coolify)
  console.log(JSON.stringify(logEntry));

  // 2. Асинхронно отправляем лог на удаленный сервер Loki (без await, чтобы не тормозить цикл воркера)
  const lokiUrl = 'http://loki-master:3100/loki/api/v1/push';
  const timestampNs = (BigInt(Date.now()) * 1000000n).toString();

  const payload = {
    streams: [
      {
        // Метки (labels), по которым ты будешь искать логи в Grafana
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
    } else {
      console.log(`[Loki Success] Log batch sent successfully`);
    }
  }).catch(error => {
    console.error('[Loki Connection Error]', error?.message || error);
  });
} // <-- ИСПРАВЛЕНО: Функция логирования теперь корректно закрыта!

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
    
    const json = (await response.json()) as { data?: { ee?: any[] } };
    return json?.data?.ee || [];
  } catch (error: any) {
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
    await pb.collection('users').authWithPassword('test@gmail.com', 'testtest');
    log('INFO', 'Worker successfully authenticated as system service account', { identity: 'test@gmail.com' });
  } catch (e: any) {
    log('ERROR', 'Worker authentication sequence failed. Termination initiated.', { error: e.message });
    return;
  }

  await syncPrices();
  await checkAutomationRules();

  // Синхронизация цен каждые 30 минут
  setInterval(syncPrices, 30 * 60 * 1000);

  // Проверка правил каждые 15 секунд
  setInterval(checkAutomationRules, 15 * 1000);

  // Расчет и обновление отчета об экономии каждые 15 секунд
  setInterval(async () => {
    log('INFO', 'Recalculating global savings report for dashboard');
    const report = await calculateSavings(0.15); 
    
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
}

if (process.argv[1] && !process.argv[1].includes('.test.')) {
  main();
}

// Чистый ES-экспорт, который идеально понимает твой package.json
export { calculateSavings };