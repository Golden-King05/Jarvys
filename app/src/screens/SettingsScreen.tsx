import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Button,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { api, type Provider } from "../api";
import { useAuth } from "../AuthContext";
import { fonts } from "../theme";

// A site added to the iOS home screen runs full-screen with no address bar
// or pull-to-refresh, and Safari can keep serving an old cached page there
// well after a new version has actually deployed — this gives it a manual
// way out. A plain reload() can still be served from cache, so this
// appends a fresh query param first: to the browser that's a different URL
// it's never cached, forcing a real network fetch of the current
// index.html (and, since it references content-hashed bundle filenames,
// whatever JS that new index.html actually points to).
function refreshApp() {
  if (Platform.OS !== "web") return;
  const url = new URL(window.location.href);
  url.searchParams.set("_refresh", Date.now().toString());
  window.location.replace(url.toString());
}

export default function SettingsScreen() {
  const { baseUrl, token, logout } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [assistantName, setAssistantName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [preferredProvider, setPreferredProvider] = useState<Provider>("groq");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordChanged, setPasswordChanged] = useState(false);

  useEffect(() => {
    if (!token) return;
    api
      .getSettings(baseUrl, token)
      .then((s) => {
        setAssistantName(s.assistantName);
        setInstructions(s.instructions);
        setPreferredProvider(s.preferredProvider);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load settings"))
      .finally(() => setLoading(false));
  }, [baseUrl, token]);

  async function save() {
    if (!token) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateSettings(baseUrl, token, { assistantName, instructions, preferredProvider });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  async function changePassword() {
    if (!token) return;
    setChangingPassword(true);
    setPasswordError(null);
    setPasswordChanged(false);
    try {
      await api.changePassword(baseUrl, token, currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordChanged(true);
    } catch (e) {
      setPasswordError(e instanceof Error ? e.message : "Failed to change password");
    } finally {
      setChangingPassword(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.label}>Assistant name</Text>
      <TextInput style={styles.input} value={assistantName} onChangeText={setAssistantName} />

      <Text style={styles.label}>Instructions / personality</Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        value={instructions}
        onChangeText={setInstructions}
        multiline
        numberOfLines={6}
        placeholder="e.g. Be brief. Prefer bullet points."
      />

      <Text style={styles.label}>Default AI</Text>
      <Text style={styles.hint}>
        Groq answers everyday messages instantly for free but is a smaller model; Gemini is a larger, generally
        higher-quality model. Whichever isn't chosen still steps in automatically as a backup if the other is
        temporarily down.
      </Text>
      <View style={styles.providerRow}>
        <TouchableOpacity
          style={[styles.providerChip, preferredProvider === "groq" && styles.providerChipActive]}
          onPress={() => setPreferredProvider("groq")}
        >
          <Text style={[styles.providerChipText, preferredProvider === "groq" && styles.providerChipTextActive]}>
            Groq
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.providerChip, preferredProvider === "gemini" && styles.providerChipActive]}
          onPress={() => setPreferredProvider("gemini")}
        >
          <Text style={[styles.providerChipText, preferredProvider === "gemini" && styles.providerChipTextActive]}>
            Gemini
          </Text>
        </TouchableOpacity>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {saved ? <Text style={styles.saved}>Saved — synced to your account.</Text> : null}

      <View style={styles.spacing}>
        <Button title={saving ? "Saving..." : "Save"} onPress={save} disabled={saving} />
      </View>

      <Text style={styles.sectionTitle}>Change password</Text>
      <Text style={styles.hint}>
        Set a new password here while you're signed in, then use it to log in on another device.
      </Text>
      <Text style={styles.label}>Current password</Text>
      <TextInput
        style={styles.input}
        value={currentPassword}
        onChangeText={setCurrentPassword}
        secureTextEntry
      />
      <Text style={styles.label}>New password</Text>
      <TextInput
        style={styles.input}
        value={newPassword}
        onChangeText={setNewPassword}
        placeholder="At least 8 characters"
        secureTextEntry
      />
      {passwordError ? <Text style={styles.error}>{passwordError}</Text> : null}
      {passwordChanged ? <Text style={styles.saved}>Password changed.</Text> : null}
      <View style={styles.spacing}>
        <Button
          title={changingPassword ? "Changing..." : "Change password"}
          onPress={changePassword}
          disabled={changingPassword || !currentPassword || !newPassword}
        />
      </View>

      {Platform.OS === "web" ? (
        <>
          <Text style={styles.sectionTitle}>Refresh app</Text>
          <Text style={styles.hint}>
            If you've added Jarvys to your iPhone's home screen, it can keep showing an old cached version even
            after an update has shipped — there's no address bar to reload from there. Use this instead.
          </Text>
          <View style={styles.spacing}>
            <Button title="Refresh app" onPress={refreshApp} />
          </View>
        </>
      ) : null}

      <View style={styles.spacing}>
        <Button title="Log out" color="#c0392b" onPress={logout} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  sectionTitle: { fontFamily: fonts.semiBold, fontSize: 15, color: "#222", marginTop: 28 },
  hint: { fontFamily: fonts.regular, fontSize: 12, color: "#888", marginTop: 4 },
  label: { fontFamily: fonts.medium, fontSize: 13, color: "#444", marginTop: 12, marginBottom: 4 },
  input: {
    fontFamily: fonts.regular,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  multiline: { minHeight: 100, textAlignVertical: "top" },
  providerRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  providerChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#ccc",
    backgroundColor: "#fff",
  },
  providerChipActive: { backgroundColor: "#222", borderColor: "#222" },
  providerChipText: { fontFamily: fonts.medium, fontSize: 13, color: "#444" },
  providerChipTextActive: { color: "#fff" },
  error: { fontFamily: fonts.regular, color: "#c0392b", marginTop: 12 },
  saved: { fontFamily: fonts.regular, color: "#27ae60", marginTop: 12 },
  spacing: { marginTop: 20 },
});
