import { useEffect, useState } from 'react';
import PocketBase from 'pocketbase';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { Cpu, Zap, Settings, ShieldCheck, Sliders, Plus, Trash2, ArrowUpRight, TrendingDown } from 'lucide-react';
import { Device, PriceData, Rule } from './types';

// Инициализируем PocketBase SDK
const pb = new PocketBase('http://pocketbase-scrrou020syoy2qbfjbl1bsx.176.112.158.3.sslip.io');

// Интерфейс для нашего нового отчета
interface SavingsReport {
  saved: number;
  percentage: number;
  total_real_cost: number;
  total_fixed_cost: number;
  records_analyzed: number;
}

export default function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [prices, setPrices] = useState<PriceData[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  
  // Состояние для хранения отчета об экономии с дефолтными значениями
  const [savings, setSavings] = useState<SavingsReport>({
    saved: 0,
    percentage: 0,
    total_real_cost: 0,
    total_fixed_cost: 0,
    records_analyzed: 0
  });

  // Состояния для формы создания нового правила
  const [selectedDevice, setSelectedDevice] = useState('');
  const [ruleType, setRuleType] = useState<Rule['type']>('max_price');
  const [threshold, setThreshold] = useState(10);

  // Функция агрегации актуальных данных из БД
  const updateData = async () => {
    try {
      // 1. Загружаем устройства
      const devList = await pb.collection('devices').getFullList<Device>({
        requestKey: null
      });
      setDevices(devList);

      // 2. Загружаем правила автоматизации
      const ruleList = await pb.collection('automation_rules').getFullList<Rule>({
        requestKey: null
      });
      setRules(ruleList);

      // 3. Загружаем историю цен
      const priceList = await pb.collection('electricity_prices').getList<PriceData>(1, 24, {
        sort: '-timestamp',
        requestKey: null
      });
      
      const formattedPrices: PriceData[] = priceList.items.reverse().map(item => {
        return {
          id: item.id,
          timestamp: item.timestamp,
          price: item.price,
          displayTime: new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
      });
      setPrices(formattedPrices);

      if (formattedPrices.length > 0) {
        setCurrentPrice(formattedPrices[formattedPrices.length - 1].price);
      }

      // ИСПРАВЛЕНО: Безопасный маппинг полей отчета при первичной загрузке
      const reportList = await pb.collection('savings_report').getFullList<any>({
        requestKey: null
      });
      if (reportList.length > 0) {
        const serverReport = reportList[0];
        setSavings({
          saved: serverReport.saved ?? 0,
          percentage: serverReport.percentage ?? 0,
          total_real_cost: serverReport.total_real_cost ?? 0,
          total_fixed_cost: serverReport.total_fixed_cost ?? 0,
          records_analyzed: serverReport.records_analyzed ?? 0
        });
      }

    } catch (err) {
      console.error("Ошибка обновления данных из PocketBase:", err);
    }
  };

  useEffect(() => {
    // ВРЕМЕННЫЙ ХАК: Авторизуем фронтенд, чтобы PocketBase отдал данные
    pb.collection('users').authWithPassword('test@gmail.com', 'testtest')
      .then(() => {
        console.log("Фронтенд успешно авторизован!");
        updateData(); // Вызываем загрузку данных ТОЛЬКО после успешного входа

        // Подписываемся на realtime изменения
        pb.collection('devices').subscribe('*', () => updateData());
        pb.collection('automation_rules').subscribe('*', () => updateData());
        pb.collection('savings_report').subscribe('*', (e) => {
          if (e.action === 'update' || e.action === 'create') {
            const record = e.record as any;
            setSavings({
              saved: record.saved ?? 0,
              percentage: record.percentage ?? 0,
              total_real_cost: record.total_real_cost ?? 0,
              total_fixed_cost: record.total_fixed_cost ?? 0,
              records_analyzed: record.records_analyzed ?? 0
            });
          }
        }, { requestKey: null });
      })
      .catch((err) => {
        console.error("Ошибка авторизации фронтенда:", err);
      });

    return () => {
      pb.collection('devices').unsubscribe('*');
      pb.collection('automation_rules').unsubscribe('*');
      pb.collection('savings_report').unsubscribe('*');
    };
  }, []);

  // Переключение физического состояния устройства (Ручной клик)
  const toggleStatus = async (id: string, currentStatus: boolean) => {
    await pb.collection('devices').update(id, { status: !currentStatus });
  };

  // Переключение режима (Автоматика / Ручной)
  const toggleAutomation = async (id: string, currentAutomated: boolean) => {
    await pb.collection('devices').update(id, { is_automated: !currentAutomated });
  };

  // Создание нового правила через форму
  const createRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDevice) return;
    
    await pb.collection('automation_rules').create({
      device: selectedDevice,
      type: ruleType,
      threshold_value: threshold
    });
    
    setSelectedDevice('');
  };

  // Удаление правила
  const deleteRule = async (id: string) => {
    await pb.collection('automation_rules').delete(id);
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-4 sm:p-8 font-sans antialiased">
      <div className="max-w-6xl mx-auto">
        
        {/* Шапка управления */}
        <header className="mb-8 border-b border-gray-800 pb-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-3xl font-extrabold text-white flex items-center gap-2">
              <Cpu className="text-yellow-500 w-8 h-8" />
              Nutika Elektrivõrgu Juhtimiskeskus
            </h1>
            <p className="text-sm text-gray-400 mt-1">Автоматизация нагрузок по тарифам Nord Pool</p>
          </div>
          <div className="bg-gray-800 text-red-500 px-5 py-3 rounded-xl border border-gray-700 shadow-lg flex items-center gap-3">
            <Zap className="text-yellow-400 w-6 h-6 animate-pulse" />
            <div>
              <span className="block text-xs text-gray-400 uppercase font-bold">Текущая цена</span>
              <span className="text-2xl font-mono font-bold text-yellow-400">{currentPrice ?? '--.--'} ¢/kWh</span>
            </div>
          </div>
        </header>

        {/* Сетка модулей */}
        <div className="grid gap-8 lg:grid-cols-3">
          
          {/* Левая колонка: Управляемые потребители и БЛОК ЭКОНОМИИ */}
          <div className="lg:col-span-1 space-y-8">
            
            {/* Модуль 1: Управляемые потребители */}
            <div className="bg-gray-800 p-6 rounded-2xl border border-gray-700 shadow-xl">
              <h2 className="text-xl font-bold mb-4 text-white flex items-center gap-2">
                <Settings className="text-blue-400 w-5 h-5" /> Потребители электросети
              </h2>
              <div className="space-y-4">
                {devices.map((device) => {
                  const hasRule = rules.some(r => r.device === device.id);
                  return (
                    <div key={device.id} className="p-4 bg-gray-900 rounded-xl border border-gray-800 space-y-3">
                      <div className="flex justify-between items-start">
                        <div>
                          <h3 className="font-bold text-white text-base">{device.name}</h3>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {hasRule ? '✅ Алгоритм назначен' : '❌ Нет activeных правил'}
                          </p>
                        </div>
                        <button
                          onClick={() => toggleStatus(device.id, device.status)}
                          className={`px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
                            device.status ? 'bg-green-500 text-gray-950 shadow-lg shadow-green-500/20' : 'bg-gray-700 text-gray-300'
                          }`}
                        >
                          {device.status ? 'ON' : 'OFF'}
                        </button>
                      </div>
                      <div className="flex gap-2 pt-1 border-t border-gray-800/60">
                        <button
                          onClick={() => toggleAutomation(device.id, device.is_automated)}
                          className={`flex-1 text-center py-1.5 rounded text-xs font-semibold transition-all ${
                            device.is_automated 
                              ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30' 
                              : 'bg-gray-800 text-gray-400 border border-transparent'
                          }`}
                        >
                          {device.is_automated ? '🤖 Режим: Автоматика' : '✋ Режим: Ручной'}
                        </button>
                      </div>
                    </div>
                  );
                })}
                {devices.length === 0 && (
                  <p className="text-gray-500 text-sm text-center py-6">Устройства не найдены.</p>
                )}
              </div>
            </div>

            {/* Модуль Säästuaruanne (Отчет об экономии) по ТЗ */}
            <div className="bg-gray-800 p-6 rounded-2xl border border-gray-700 shadow-xl space-y-4">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <ArrowUpRight className="text-green-400 w-5 h-5" /> Säästuaruanne (Экономия)
              </h2>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-gray-900 rounded-xl border border-gray-800">
                  <span className="text-[10px] uppercase font-bold text-gray-400 block">Чистый профит</span>
                  <span className="text-2xl font-mono font-bold text-green-400">+{savings.saved} €</span>
                </div>
                <div className="p-4 bg-gray-900 rounded-xl border border-gray-800">
                  <span className="text-[10px] uppercase font-bold text-gray-400 block">Эффективность</span>
                  <span className="text-2xl font-mono font-bold text-blue-400">{savings.percentage}%</span>
                </div>
              </div>

              <div className="p-4 bg-gray-900 rounded-xl border border-gray-800 space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-400 flex items-center gap-1"><TrendingDown className="w-3 h-3 text-amber-400" /> Затраты по бирже:</span>
                  <span className="font-mono text-white font-semibold">{savings.total_real_cost} €</span>
                </div>
                <div className="flex justify-between border-t border-gray-800/80 pt-2">
                  <span className="text-gray-400">При фикс. тарифе:</span>
                  <span className="font-mono text-gray-400 line-through">{savings.total_fixed_cost} €</span>
                </div>
                <div className="text-[10px] text-gray-500 text-right pt-1 font-mono">
                  Анализировано тиков: {savings.records_analyzed}
                </div>
              </div>
            </div>

          </div>

          {/* Правая колонка: График и Бизнес-правила */}
          <div className="lg:col-span-2 space-y-8">
            
            {/* Модуль 2: График цен Nord Pool */}
            <div className="bg-gray-800 p-6 rounded-2xl border border-gray-700 shadow-xl">
              <h2 className="text-xl font-bold mb-4 text-white">📊 Биржевые колебания цен (24 часа)</h2>
              <div className="w-full h-64">
                {prices.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={prices} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#facc15" stopOpacity={0.2}/>
                          <stop offset="95%" stopColor="#facc15" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                      <XAxis dataKey="displayTime" stroke="#9ca3af" fontSize={11} />
                      <YAxis stroke="#9ca3af" fontSize={11} unit="¢" />
                      <Tooltip contentStyle={{ backgroundColor: '#1f2937', borderColor: '#4b5563', borderRadius: '8px' }} />
                      <Area type="monotone" dataKey="price" stroke="#facc15" strokeWidth={3} fill="url(#colorPrice)" />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-gray-500 text-sm">Ожидание данных от API Elering...</div>
                )}
              </div>
            </div>

            {/* Модуль 3: Управление алгоритмами автоматизации */}
            <div className="bg-gray-800 p-6 rounded-2xl border border-gray-700 shadow-xl grid md:grid-cols-2 gap-6">
              
              {/* Левая часть: Форма */}
              <div>
                <h3 className="text-lg font-bold mb-3 text-white flex items-center gap-2">
                  <Sliders className="text-yellow-500 w-5 h-5" /> Конструктор правил
                </h3>
                <form onSubmit={createRule} className="space-y-3">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Устройство</label>
                    <select
                      value={selectedDevice}
                      onChange={(e) => setSelectedDevice(e.target.value)}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg p-2 text-sm text-white focus:outline-none focus:border-yellow-500"
                    >
                      <option value="">Выберите устройство...</option>
                      {devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Алгоритм экономии</label>
                    <select
                      value={ruleType}
                      onChange={(e) => setRuleType(e.target.value as any)}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg p-2 text-sm text-white focus:outline-none focus:border-yellow-500"
                    >
                      <option value="max_price">Порог цены (Выключать если выше ¢/kWh)</option>
                      <option value="cheapest_hours">N самых дешевых часов за сутки</option>
                      <option value="smart_saving">Умная экономия (% от средней за сутки)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Параметр алгоритма</label>
                    <input
                      type="number"
                      step="0.1"
                      value={threshold}
                      onChange={(e) => setThreshold(Number(e.target.value))}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg p-2 text-sm font-mono text-white focus:outline-none focus:border-yellow-500"
                    />
                  </div>

                  <button
                    type="submit"
                    className="w-full bg-yellow-500 text-gray-950 font-bold p-2 rounded-lg text-sm hover:bg-yellow-400 transition-colors flex items-center justify-center gap-1"
                  >
                    <Plus className="w-4 h-4" /> Активировать правило
                  </button>
                </form>
              </div>

              {/* Правая часть: Список */}
              <div className="border-t md:border-t-0 md:border-l border-gray-700/60 md:pl-6 pt-4 md:pt-0">
                <h3 className="text-lg font-bold mb-3 text-white">Активные триггеры в сети</h3>
                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                  {rules.map((rule) => {
                    const dev = devices.find(d => d.id === rule.device);
                    return (
                      <div key={rule.id} className="p-3 bg-gray-900 rounded-lg border border-gray-800 flex justify-between items-center text-xs">
                        <div>
                          <p className="font-bold text-white">{dev ? dev.name : 'Удаленное устройство'}</p>
                          <p className="text-gray-400 mt-0.5 font-mono">
                            {rule.type === 'max_price' && `Порог: ≤ ${rule.threshold_value} ¢/kWh`}
                            {rule.type === 'cheapest_hours' && `Режим: ${rule.threshold_value} деш. часов`}
                            {rule.type === 'smart_saving' && `Скидка: -${rule.threshold_value}% от средней`}
                          </p>
                        </div>
                        <button onClick={() => deleteRule(rule.id)} className="text-gray-500 hover:text-red-400 transition-colors">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    );
                  })}
                  {rules.length === 0 && (
                    <p className="text-gray-500 text-center py-8 text-sm">В системе нет настроенных триггеров.</p>
                  )}
                </div>
              </div>

            </div>

            {/* Статус связи */}
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <ShieldCheck className="text-green-500 w-4 h-4" />
              <span>Поток данных PocketBase WebSockets активен.</span>
            </div>

          </div>

        </div>
      </div>
    </div>
  );
}