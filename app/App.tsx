import React, { useState } from "react";
import { ActivityIndicator, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import { AuthProvider, useAuth } from "./src/AuthContext";
import { fonts } from "./src/theme";
import LoginScreen from "./src/screens/LoginScreen";
import HomeScreen from "./src/screens/HomeScreen";
import SettingsScreen from "./src/screens/SettingsScreen";

type Tab = "chat" | "settings";

function AuthedApp() {
  const [tab, setTab] = useState<Tab>("chat");

  return (
    <View style={styles.flex}>
      <View style={styles.tabBar}>
        <TouchableOpacity onPress={() => setTab("chat")}>
          <Text style={tab === "chat" ? styles.tabActive : styles.tab}>Chat</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setTab("settings")}>
          <Text style={tab === "settings" ? styles.tabActive : styles.tab}>Settings</Text>
        </TouchableOpacity>
      </View>
      {tab === "chat" ? <HomeScreen /> : <SettingsScreen />}
    </View>
  );
}

function Root() {
  const { loading, token } = useAuth();

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return token ? <AuthedApp /> : <LoginScreen />;
}

export default function App() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  if (!fontsLoaded) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.flex}>
      <StatusBar style="auto" />
      <AuthProvider>
        <Root />
      </AuthProvider>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  tabBar: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 24,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  tab: { fontFamily: fonts.regular, fontSize: 16, color: "#888" },
  tabActive: { fontFamily: fonts.semiBold, fontSize: 16, color: "#000" },
});
