import PocketBase from 'pocketbase';

const PB_URL = 'http://pocketbase-scrrou020syoy2qbfjbl1bsx.176.112.158.3.sslip.io';
const pb = new PocketBase(PB_URL);

// Функция для генерации структурированных JSON-логов для Grafana Loki
function log(level: 'INFO' | 'WARNING' | 'ERROR', message: string, context: object = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: level,
    message: message,
    ...context
  };
  // Выводим строго в формате JSON одной строкой, как требует ТЗ
  console.log(JSON.stringify(logEntry));
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
    const json = await response.json();
    return json.data.ee || [];
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
    
    // ХАК: Жестко сбрасываем минуты и секунды в 0, чтобы время в базе было идеально ровным!
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
      // Игнорируем ошибку 400 (дубликат по уникальному индексу timestamp)
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

  // 1. ОТКАТНОЙ ПОИСК ЦЕНЫ (ФИКС ОШИБКИ ПУСТОГО ЧАСА)
  try {
    const currentPriceRecord = await pb.collection('electricity_prices').getFirstListItem(`timestamp="${currentHourISO}"`);
    currentPrice = currentPriceRecord.price;
  } catch (e) {
    log('WARNING', 'Exact price for current hour not found, trying fallback to latest record', { expectedHour: currentHourISO });
    try {
      const latestPrices = await pb.collection('electricity_prices').getList(1, 1, {
        sort: '-timestamp'
      });
      if (latestPrices.items.length > 0) {
        currentPrice = latestPrices.items[0].price;
        log('INFO', 'Fallback price successfully resolved', { fallbackPrice: currentPrice, resolvedTimestamp: latestPrices.items[0].timestamp });
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

  // 2. ПОЛУЧЕНИЕ ДАННЫХ ИЗ БАЗЫ
  let devices = [];
  let rules = [];
  try {
    devices = await pb.collection('devices').getFullList({ filter: 'is_automated = true' });
    rules = await pb.collection('automation_rules').getFullList();
  } catch (err: any) {
    log('ERROR', 'Failed to fetch automation infrastructure from database', { error: err.message });
    return;
  }

  // 3. ПРОВЕРКА ПРАВИЛ ДЛЯ КАЖДОГО УСТРОЙСТВА
  for (const device of devices) {
    const deviceRule = rules.find(r => r.device === device.id);
    
    if (!deviceRule) {
      log('WARNING', 'Device has automation enabled but no rule configuration exists', { deviceName: device.name, deviceId: device.id });
      continue;
    }

    let shouldBeOn = false;

    // Ссылки на диапазон суток для сложных алгоритмов (cheapest_hours и smart_saving)
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

    // Логика 1: Порог максимальной цены
    if (deviceRule.type === 'max_price') {
      shouldBeOn = currentPrice <= deviceRule.threshold_value;
    } 
    
    // Логика 2: N самых дешевых часов в сутках
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
    
    // Логика 3: Умная экономия (% от средней цены за сутки)
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

    // 4. ОБНОВЛЕНИЕ СТАТУСА УСТРОЙСТВА ПРИ ИЗМЕНЕНИИ
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
  log('INFO', 'Automation rules verification completed');
}

// 3. Главный цикл воркера
async function main() {
  try {
    await pb.collection('users').authWithPassword('test@gmail.com', 'testtest');
    log('INFO', 'Worker successfully authenticated as system service account', { identity: 'test@gmail.com' });
  } catch (e: any) {
    log('ERROR', 'Worker authentication sequence failed. Termination initiated.', { error: e.message });
    return;
  }

  // Сразу при запуске обновляем цены и проверяем автоматику
  await syncPrices();
  await checkAutomationRules();

  // Синхронизация цен каждые 30 минут
  setInterval(syncPrices, 30 * 60 * 1000);

  // Проверка правил каждые 15 секунд (демо-интервал)
  setInterval(checkAutomationRules, 15 * 1000);
}

main();