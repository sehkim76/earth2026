export const AUTH_DEVICE_STORAGE_KEY = "ARMISSION_DEVICE_ID";
export const AUTH_NICKNAME_STORAGE_KEY = "ARMISSION_NICKNAME";

export const AUTH_MIN_NICKNAME_LENGTH = 2;
export const AUTH_MAX_NICKNAME_LENGTH = 12;

export const AUTH_NICKNAME_REGEX = /^[0-9A-Za-z가-힣 _]+$/;

export const isValidNickname = (nickname: string): boolean => {
  const trimmed = nickname.trim();

  if (trimmed.length < AUTH_MIN_NICKNAME_LENGTH || trimmed.length > AUTH_MAX_NICKNAME_LENGTH) {
    return false;
  }

  return AUTH_NICKNAME_REGEX.test(trimmed);
};
