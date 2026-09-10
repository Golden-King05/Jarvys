import React, { useEffect, useState } from "react";
import { ActivityIndicator, Platform, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
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
  const [showOsm, setShowOsm] = useState(false);

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
            showOsm={showOsm}
            setShowOsm={setShowOsm}
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

// iOS Safari rubber-bands the whole page by default — nothing here uses that
// scroll (every screen manages its own internal scrolling), so left alone it
// just lets a stray swipe drag the entire app up/down past its own edges,
// revealing blank space above or below and leaving things like the map
// mid-drag until you scroll back. Locking html/body to the viewport size
// with overflow hidden stops the outer page itself from ever scrolling.
function useLockPageScrollOnWeb() {
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const html = document.documentElement;
    const prevHtml = { overflow: html.style.overflow, height: html.style.height };
    const prevBody = {
      overflow: document.body.style.overflow,
      position: document.body.style.position,
      width: document.body.style.width,
      height: document.body.style.height,
    };
    html.style.overflow = "hidden";
    html.style.height = "100%";
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.width = "100%";
    document.body.style.height = "100%";
    // overscrollBehavior isn't in React Native Web's DOM style typings.
    (document.body.style as unknown as { overscrollBehavior: string }).overscrollBehavior = "none";
    return () => {
      html.style.overflow = prevHtml.overflow;
      html.style.height = prevHtml.height;
      document.body.style.overflow = prevBody.overflow;
      document.body.style.position = prevBody.position;
      document.body.style.width = prevBody.width;
      document.body.style.height = prevBody.height;
    };
  }, []);
}

export default function App() {
  useLockPageScrollOnWeb();
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
