import React, { useEffect, useState } from "react";
import { ActivityIndicator, Button, StyleSheet, Text, TextInput, View } from "react-native";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import { fonts } from "../theme";

export default function SettingsScreen() {
  const { baseUrl, token, logout } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [assistantName, setAssistantName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!token) return;
    api
      .getSettings(baseUrl, token)
      .then((s) => {
        setAssistantName(s.assistantName);
        setInstructions(s.instructions);
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
      await api.updateSettings(baseUrl, token, { assistantName, instructions });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setSaving(false);
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
    <View style={styles.container}>
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

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {saved ? <Text style={styles.saved}>Saved — synced to your account.</Text> : null}

      <View style={styles.spacing}>
        <Button title={saving ? "Saving..." : "Save"} onPress={save} disabled={saving} />
      </View>

      <View style={styles.spacing}>
        <Button title="Log out" color="#c0392b" onPress={logout} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
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
  error: { fontFamily: fonts.regular, color: "#c0392b", marginTop: 12 },
  saved: { fontFamily: fonts.regular, color: "#27ae60", marginTop: 12 },
  spacing: { marginTop: 20 },
});
