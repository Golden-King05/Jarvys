import AsyncStorage from "@react-native-async-storage/async-storage";

const TOKEN_KEY = "jarvys.token";
const BASE_URL_KEY = "jarvys.baseUrl";

// No server on a phone yet, so this only works for the web/PC target out of
// the box. iOS builds need a real address (e.g. your PC's LAN IP) set from
// the in-app Settings screen.
export const DEFAULT_BASE_URL = "http://localhost:4000";

export const tokenStorage = {
  get: () => AsyncStorage.getItem(TOKEN_KEY),
  set: (token: string) => AsyncStorage.setItem(TOKEN_KEY, token),
  clear: () => AsyncStorage.removeItem(TOKEN_KEY),
};

export const baseUrlStorage = {
  get: async () => (await AsyncStorage.getItem(BASE_URL_KEY)) ?? DEFAULT_BASE_URL,
  set: (url: string) => AsyncStorage.setItem(BASE_URL_KEY, url),
};
