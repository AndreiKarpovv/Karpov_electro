import { describe, test, expect, mock, beforeEach } from 'bun:test';

// 1. Регистрируем мок модуля PocketBase ДО любых импортов воркера
const mockGetFullList = mock(() => [] as any[]);

mock.module('pocketbase', () => {
  return {
    default: class {
      collection() {
        return {
          getFullList: mockGetFullList
        };
      }
    }
  };
});

describe('Smart Grid Экономия (calculateSavings)', () => {
  let calculateSavings: any;

  // Динамически импортируем функцию только ПОСЛЕ того, как применился мок
  beforeEach(async () => {
    const workerModule = await import('./worker');
    calculateSavings = workerModule.calculateSavings;
    mockGetFullList.mockClear(); // Очищаем историю вызовов перед каждым тестом
  });
  
  test('Должен возвращать нули, если история потребления пустая', async () => {
    mockGetFullList.mockImplementation(() => [] as any[]);

    const result = await calculateSavings(0.15);

    expect(result).toEqual({
      saved: 0,
      percentage: 0,
      totalRealCost: 0,
      totalFixedCost: 0,
      recordsAnalyzed: 0
    });
  });

  test('Должен правильно считать экономию, когда биржа дешевле фиксированного тарифа', async () => {
    mockGetFullList.mockImplementation(() => [
      { kwh_consumed: 2, price_at_that_time: 5.0 } 
    ] as any[]);

    const result = await calculateSavings(0.15);

    expect(result.saved).toBe(0.20);
    expect(result.percentage).toBe(66.7);
    expect(result.totalRealCost).toBe(0.10);
    expect(result.totalFixedCost).toBe(0.30);
    expect(result.recordsAnalyzed).toBe(1);
  });

  test('Должен уходить в минус (убыток) и выдавать 0% эффективности, если биржа дороже фикса', async () => {
    mockGetFullList.mockImplementation(() => [
      { kwh_consumed: 1, price_at_that_time: 50.0 }
    ] as any[]);

    const result = await calculateSavings(0.15);

    expect(result.saved).toBe(-0.35);
    expect(result.percentage).toBe(0); 
    expect(result.totalRealCost).toBe(0.50);
    expect(result.totalFixedCost).toBe(0.15);
  });
});