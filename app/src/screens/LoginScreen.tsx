import React, { useState } from "react";
import {
  ActivityIndicator,
  Button,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAuth } from "../AuthContext";

export default function LoginScreen() {
  const { login, register, baseUrl, setBaseUrl } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [serverUrl, setServerUrl] = useState(baseUrl);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handle(action: "login" | "register") {
    setError(null);
    setBusy(true);
    try {
      await setBaseUrl(serverUrl.trim());
      if (action === "login") {
        await login(email.trim(), password);
      } else {
        await register(email.trim(), password);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Jarvys</Text>
      <Text style={styles.subtitle}>Sign in to sync your assistant everywhere</Text>

      <Text style={styles.label}>Server URL</Text>
      <TextInput
        style={styles.input}
        value={serverUrl}
        onChangeText={setServerUrl}
        placeholder="http://localhost:4000"
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.label}>Email</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
      />

      <Text style={styles.label}>Password</Text>
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        placeholder="At least 8 characters"
        secureTextEntry
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {busy ? (
        <ActivityIndicator style={styles.spacing} />
      ) : (
        <View style={styles.spacing}>
          <Button title="Log in" onPress={() => handle("login")} />
          <View style={{ height: 8 }} />
          <Button title="Create account" onPress={() => handle("register")} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 24, maxWidth: 420, width: "100%", alignSelf: "center" },
  title: { fontSize: 32, fontWeight: "700", textAlign: "center" },
  subtitle: { fontSize: 14, color: "#666", textAlign: "center", marginBottom: 24 },
  label: { fontSize: 13, color: "#444", marginTop: 12, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  error: { color: "#c0392b", marginTop: 12 },
  spacing: { marginTop: 20 },
});
