import React, { useState } from "react";
import { ActivityIndicator, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { AuthProvider, useAuth } from "./src/AuthContext";
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
  tab: { fontSize: 16, color: "#888" },
  tabActive: { fontSize: 16, color: "#000", fontWeight: "700" },
});
