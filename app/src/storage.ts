import AsyncStorage from "@react-native-async-storage/async-storage";

const TOKEN_KEY = "jarvys.token";

export const tokenStorage = {
  get: () => AsyncStorage.getItem(TOKEN_KEY),
  set: (token: string) => AsyncStorage.setItem(TOKEN_KEY, token),
  clear: () => AsyncStorage.removeItem(TOKEN_KEY),
};
