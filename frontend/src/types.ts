export interface Device {
  id: string;
  name: string;
  status: boolean;
  is_automated: boolean;
}

export interface PriceData {
  id: string;
  timestamp: string;
  price: number;
  displayTime?: string; 
}

export interface Rule {
  id: string;
  device: string;
  type: 'max_price' | 'cheapest_hours' | 'smart_saving';
  threshold_value: number;
}