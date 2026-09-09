import React, { useEffect, useState } from "react";
import { ActivityIndicator, Button, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
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
  error: { fontFamily: fonts.regular, color: "#c0392b", marginTop: 12 },
  saved: { fontFamily: fonts.regular, color: "#27ae60", marginTop: 12 },
  spacing: { marginTop: 20 },
});
