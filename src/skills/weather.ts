import type { ToolDefinition } from "../providers/types.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// --- Tool Definitions ---

export const weatherToolDefinitions: ToolDefinition[] = [
  {
    name: "get_weather",
    description:
      "Get current weather conditions for a location. Returns temperature (C/F), feels like, humidity, wind speed/direction, description, and visibility.",
    input_schema: {
      type: "object" as const,
      properties: {
        location: {
          type: "string",
          description:
            "Location to get weather for (city name, zip code, or coordinates). Examples: 'London', 'New York', '90210', '48.8566,2.3522'",
        },
      },
      required: ["location"],
    },
  },
  {
    name: "get_forecast",
    description:
      "Get a multi-day weather forecast for a location. Returns daily high/low temps, description, chance of rain, and sunrise/sunset times.",
    input_schema: {
      type: "object" as const,
      properties: {
        location: {
          type: "string",
          description:
            "Location to get forecast for (city name, zip code, or coordinates). Examples: 'London', 'New York', '90210'",
        },
        days: {
          type: "number",
          description: "Number of forecast days (1-3, default: 3)",
        },
      },
      required: ["location"],
    },
  },
];

// --- Helpers ---

interface WttrCurrentCondition {
  temp_C: string;
  temp_F: string;
  FeelsLikeC: string;
  FeelsLikeF: string;
  humidity: string;
  windspeedKmph: string;
  windspeedMiles: string;
  winddir16Point: string;
  weatherDesc: { value: string }[];
  visibility: string;
  visibilityMiles: string;
  uvIndex: string;
  pressureMB: string;
}

interface WttrWeatherDay {
  date: string;
  maxtempC: string;
  maxtempF: string;
  mintempC: string;
  mintempF: string;
  avgtempC: string;
  avgtempF: string;
  hourly: {
    weatherDesc: { value: string }[];
    chanceofrain: string;
  }[];
  astronomy: {
    sunrise: string;
    sunset: string;
  }[];
}

interface WttrResponse {
  current_condition: WttrCurrentCondition[];
  weather: WttrWeatherDay[];
  nearest_area: {
    areaName: { value: string }[];
    country: { value: string }[];
    region: { value: string }[];
  }[];
}

async function fetchWttrData(location: string): Promise<WttrResponse> {
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Bob-Agent/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      `wttr.in returned HTTP ${response.status}: ${response.statusText}`
    );
  }

  const data = (await response.json()) as WttrResponse;
  return data;
}

function formatAreaName(data: WttrResponse): string {
  const area = data.nearest_area?.[0];
  if (!area) return "";
  const name = area.areaName?.[0]?.value ?? "";
  const region = area.region?.[0]?.value ?? "";
  const country = area.country?.[0]?.value ?? "";
  const parts = [name, region, country].filter(Boolean);
  return parts.join(", ");
}

// --- Handlers ---

export async function handleGetWeather(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const location = input.location as string;
  if (!location) {
    return { success: false, output: "location is required" };
  }

  try {
    const data = await fetchWttrData(location);
    const current = data.current_condition?.[0];

    if (!current) {
      return {
        success: false,
        output: `No weather data available for "${location}". Check the location name and try again.`,
      };
    }

    const areaName = formatAreaName(data);
    const description =
      current.weatherDesc?.[0]?.value ?? "Unknown conditions";

    const lines = [
      `Weather for ${areaName || location}`,
      ``,
      `Conditions: ${description}`,
      `Temperature: ${current.temp_C}\u00B0C / ${current.temp_F}\u00B0F`,
      `Feels like: ${current.FeelsLikeC}\u00B0C / ${current.FeelsLikeF}\u00B0F`,
      `Humidity: ${current.humidity}%`,
      `Wind: ${current.windspeedKmph} km/h (${current.windspeedMiles} mph) ${current.winddir16Point}`,
      `Visibility: ${current.visibility} km (${current.visibilityMiles} miles)`,
      `UV Index: ${current.uvIndex}`,
      `Pressure: ${current.pressureMB} mb`,
    ];

    return { success: true, output: lines.join("\n") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: `Failed to fetch weather for "${location}": ${message}`,
    };
  }
}

export async function handleGetForecast(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const location = input.location as string;
  if (!location) {
    return { success: false, output: "location is required" };
  }

  const days = Math.min(3, Math.max(1, (input.days as number) ?? 3));

  try {
    const data = await fetchWttrData(location);
    const forecast = data.weather;

    if (!forecast || forecast.length === 0) {
      return {
        success: false,
        output: `No forecast data available for "${location}". Check the location name and try again.`,
      };
    }

    const areaName = formatAreaName(data);
    const lines: string[] = [`${days}-day forecast for ${areaName || location}`, ``];

    const daysToShow = forecast.slice(0, days);

    for (const day of daysToShow) {
      // Determine the most common weather description from hourly data
      const descriptions = day.hourly
        ?.map((h) => h.weatherDesc?.[0]?.value)
        .filter(Boolean) ?? [];
      const description = descriptions.length > 0
        ? getMostCommon(descriptions)
        : "Unknown";

      // Get max chance of rain across all hours
      const rainChances = day.hourly
        ?.map((h) => parseInt(h.chanceofrain, 10))
        .filter((n) => !isNaN(n)) ?? [];
      const maxRainChance = rainChances.length > 0
        ? Math.max(...rainChances)
        : 0;

      const sunrise = day.astronomy?.[0]?.sunrise ?? "N/A";
      const sunset = day.astronomy?.[0]?.sunset ?? "N/A";

      lines.push(
        `--- ${day.date} ---`,
        `  High: ${day.maxtempC}\u00B0C / ${day.maxtempF}\u00B0F`,
        `  Low: ${day.mintempC}\u00B0C / ${day.mintempF}\u00B0F`,
        `  Avg: ${day.avgtempC}\u00B0C / ${day.avgtempF}\u00B0F`,
        `  Conditions: ${description}`,
        `  Chance of rain: ${maxRainChance}%`,
        `  Sunrise: ${sunrise}`,
        `  Sunset: ${sunset}`,
        ``
      );
    }

    return { success: true, output: lines.join("\n").trimEnd() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: `Failed to fetch forecast for "${location}": ${message}`,
    };
  }
}

/**
 * Return the most frequently occurring string in an array.
 */
function getMostCommon(arr: string[]): string {
  const counts = new Map<string, number>();
  for (const item of arr) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  let best = arr[0];
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}
