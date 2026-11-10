export type PlayerCharacter = "walking" | "fallenAngel";

export type MapStyle = "satellite" | "globe" | "cesium";

export type MapUserSettings = {
  selectedCharacter: PlayerCharacter;
  mapStyle: MapStyle;
};

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const DEFAULT_SELECTED_CHARACTER: PlayerCharacter = "fallenAngel";

export const DEFAULT_MAP_STYLE: MapStyle = "satellite";

export const DEFAULT_MAP_USER_SETTINGS: MapUserSettings = {
  selectedCharacter: DEFAULT_SELECTED_CHARACTER,
  mapStyle: DEFAULT_MAP_STYLE,
};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null) {
    return true;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }

  if (typeof value !== "object") {
    return false;
  }

  return Object.values(value).every((item) => isJsonValue(item));
};

const isJsonObject = (value: unknown): value is { [key: string]: JsonValue } => {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isJsonValue(value);
};

const parsePlayerCharacter = (value: unknown): PlayerCharacter => {
  if (value === "walking" || value === "fallenAngel") {
    return value;
  }

  return DEFAULT_SELECTED_CHARACTER;
};

export const parseMapStyle = (value: unknown): MapStyle => {
  if (value === "satellite" || value === "globe" || value === "cesium") {
    return value;
  }

  return DEFAULT_MAP_STYLE;
};

export const sanitizeMapUserSettings = (value: unknown): MapUserSettings => {
  if (!isJsonObject(value)) {
    return DEFAULT_MAP_USER_SETTINGS;
  }

  const selectedCharacter = parsePlayerCharacter(value.selectedCharacter);

  const mapStyle = parseMapStyle(value.mapStyle);

  return {
    selectedCharacter,
    mapStyle,
  };
};

export const extractMapUserSettingsFromData = (data: unknown): MapUserSettings => {
  if (!isJsonObject(data)) {
    return DEFAULT_MAP_USER_SETTINGS;
  }

  const candidate = isJsonObject(data.mapSettings) ? data.mapSettings : data;
  return sanitizeMapUserSettings(candidate);
};

export const mergeMapUserSettingsIntoData = (params: {
  existingData: unknown;
  settings: MapUserSettings;
}): { [key: string]: JsonValue } => {
  const mapSettings: JsonValue = {
    selectedCharacter: params.settings.selectedCharacter,
    mapStyle: params.settings.mapStyle,
  };

  if (isJsonObject(params.existingData)) {
    return {
      ...params.existingData,
      mapSettings,
    };
  }

  if (isJsonValue(params.existingData) && params.existingData !== null) {
    return {
      mapSettings,
      legacyData: params.existingData,
    };
  }

  return {
    mapSettings,
  };
};
