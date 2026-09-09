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
import type { LayerCommand, MapData } from "./src/api";
import LoginScreen from "./src/screens/LoginScreen";
import HomeScreen from "./src/screens/HomeScreen";
import MapScreen from "./src/screens/MapScreen";
import SettingsScreen from "./src/screens/SettingsScreen";

type Tab = "chat" | "map" | "settings";

function AuthedApp() {
  const [tab, setTab] = useState<Tab>("chat");
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [verifySignal, setVerifySignal] = useState(0);
  // Lifted out of MapScreen so they survive switching away from the Map tab
  // (MapScreen unmounts when hidden) and so the assistant's set_map_layer
  // tool can change them from the Chat tab too.
  const [showRadar, setShowRadar] = useState(false);
  const [showTimezoneBands, setShowTimezoneBands] = useState(false);
  const [showPins, setShowPins] = useState(true);
  const [showFlights, setShowFlights] = useState(false);
  const [showWikipedia, setShowWikipedia] = useState(false);

  function handleLayerCommand(cmd: LayerCommand) {
    if (cmd.layer === "radar") setShowRadar(cmd.enabled);
    else if (cmd.layer === "timezones") setShowTimezoneBands(cmd.enabled);
    else if (cmd.layer === "pins") setShowPins(cmd.enabled);
    else if (cmd.layer === "flights") setShowFlights(cmd.enabled);
    else if (cmd.layer === "wikipedia") setShowWikipedia(cmd.enabled);
  }

  return (
    <View style={styles.flex}>
      <View style={styles.tabBar}>
        <View style={styles.tabGroup}>
          <TouchableOpacity onPress={() => setTab("chat")}>
            <Text style={tab === "chat" ? styles.tabActive : styles.tab}>Chat</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setTab("map")}>
            <Text style={tab === "map" ? styles.tabActive : styles.tab}>Map</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={() => setTab("settings")} hitSlop={8}>
          <Text style={styles.gearIcon}>⚙</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.flex}>
        <View style={[styles.flex, tab !== "chat" && styles.hidden]}>
          <HomeScreen onMapData={setMapData} verifySignal={verifySignal} onLayerCommand={handleLayerCommand} />
        </View>
        {tab === "map" ? (
          <MapScreen
            mapData={mapData}
            onVerifyMap={() => {
              setTab("chat");
              setVerifySignal((n) => n + 1);
            }}
            showRadar={showRadar}
            setShowRadar={setShowRadar}
            showTimezoneBands={showTimezoneBands}
            setShowTimezoneBands={setShowTimezoneBands}
            showPins={showPins}
            setShowPins={setShowPins}
            showFlights={showFlights}
            setShowFlights={setShowFlights}
            showWikipedia={showWikipedia}
            setShowWikipedia={setShowWikipedia}
          />
        ) : null}
        {tab === "settings" ? <SettingsScreen /> : null}
      </View>
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
  hidden: { display: "none" },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  tabBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  tabGroup: { flexDirection: "row", gap: 24 },
  tab: { fontFamily: fonts.regular, fontSize: 16, color: "#888" },
  tabActive: { fontFamily: fonts.semiBold, fontSize: 16, color: "#000" },
  gearIcon: { fontSize: 20, color: "#444" },
});
