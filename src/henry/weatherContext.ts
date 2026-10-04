/**
 * Henry weather awareness — fetches real current conditions from Open-Meteo (no API key).
 * Caches for 30 min so it doesn't re-fetch on every message.
 */

export interface WeatherSnapshot {
  city: string;
  temperature: number;
  feelsLike: number;
  condition: string;
  conditionEmoji: string;
  humidity: number;
  windMph: number;
  isDay: boolean;
  fetchedAt: number;
}

const CACHE_KEY = 'henry:weather_cache';
const CACHE_TTL_MS = 30 * 60 * 1000;

const WMO_CODES: Record<number, { label: string; emoji: string }> = {
  0:  { label: 'clear sky', emoji: '☀️' },
  1:  { label: 'mostly clear', emoji: '🌤️' },
  2:  { label: 'partly cloudy', emoji: '⛅' },
  3:  { label: 'overcast', emoji: '☁️' },
  45: { label: 'foggy', emoji: '🌫️' },
  48: { label: 'rime fog', emoji: '🌫️' },
  51: { label: 'light drizzle', emoji: '🌦️' },
  53: { label: 'drizzle', emoji: '🌦️' },
  55: { label: 'heavy drizzle', emoji: '🌧️' },
  61: { label: 'light rain', emoji: '🌧️' },
  63: { label: 'rain', emoji: '🌧️' },
  65: { label: 'heavy rain', emoji: '🌧️' },
  71: { label: 'light snow', emoji: '🌨️' },
  73: { label: 'snow', emoji: '❄️' },
  75: { label: 'heavy snow', emoji: '❄️' },
  80: { label: 'rain showers', emoji: '🌦️' },
  81: { label: 'moderate showers', emoji: '🌧️' },
  82: { label: 'violent showers', emoji: '⛈️' },
  85: { label: 'snow showers', emoji: '🌨️' },
  95: { label: 'thunderstorm', emoji: '⛈️' },
  96: { label: 'thunderstorm with hail', emoji: '⛈️' },
  99: { label: 'thunderstorm with heavy hail', emoji: '⛈️' },
};

function getCondition(code: number): { label: string; emoji: string } {
  return WMO_CODES[code] ?? { label: 'unknown', emoji: '🌡️' };
}

function loadCache(): WeatherSnapshot | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const snap: WeatherSnapshot = JSON.parse(raw);
    if (Date.now() - snap.fetchedAt > CACHE_TTL_MS) return null;
    return snap;
  } catch {
    return null;
  }
}

function saveCache(snap: WeatherSnapshot) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(snap)); } catch { /* ignore */ }
}

async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const manualCity = localStorage.getItem('henry:home_city');
    if (manualCity?.trim()) return manualCity.trim();

    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      { headers: { 'User-Agent': 'HenryAI/1.0' } }
    );
    if (!res.ok) throw new Error('geo failed');
    const data = await res.json();
    return (
      data.address?.city ||
      data.address?.town ||
      data.address?.village ||
      data.address?.county ||
      'your area'
    );
  } catch {
    return localStorage.getItem('henry:home_city') || 'your area';
  }
}

async function getPosition(): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('no geolocation')); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      reject,
      { timeout: 6000, maximumAge: 60 * 60 * 1000 }
    );
  });
}

export async function fetchWeather(): Promise<WeatherSnapshot | null> {
  const cached = loadCache();
  if (cached) return cached;

  try {
    const { lat, lon } = await getPosition();
    const [weatherRes, city] = await Promise.all([
      fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,is_day` +
        `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`
      ),
      reverseGeocode(lat, lon),
    ]);

    if (!weatherRes.ok) return null;
    const data = await weatherRes.json();
    const cur = data.current;
    const { label, emoji } = getCondition(cur.weather_code ?? 0);

    const snap: WeatherSnapshot = {
      city,
      temperature: Math.round(cur.temperature_2m ?? 0),
      feelsLike: Math.round(cur.apparent_temperature ?? 0),
      condition: label,
      conditionEmoji: emoji,
      humidity: Math.round(cur.relative_humidity_2m ?? 0),
      windMph: Math.round(cur.wind_speed_10m ?? 0),
      isDay: cur.is_day === 1,
      fetchedAt: Date.now(),
    };

    saveCache(snap);
    return snap;
  } catch {
    return null;
  }
}

export function formatWeatherBlock(w: WeatherSnapshot | null): string {
  if (!w) return '';
  const time = new Date(w.fetchedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return `Current conditions at home (${w.city}, as of ${time}): ${w.conditionEmoji} ${w.temperature}°F, feels like ${w.feelsLike}°F, ${w.condition}. Humidity ${w.humidity}%, wind ${w.windMph} mph.`;
}

let _weatherPromise: Promise<WeatherSnapshot | null> | null = null;

/** Start a background weather fetch — call once at app init, then re-call in buildCompanionStreamSystemPrompt */
export function prefetchWeather(): void {
  if (!_weatherPromise) {
    _weatherPromise = fetchWeather().finally(() => { _weatherPromise = null; });
  }
}

export async function getWeather(): Promise<WeatherSnapshot | null> {
  const cached = loadCache();
  if (cached) return cached;
  return fetchWeather();
}
