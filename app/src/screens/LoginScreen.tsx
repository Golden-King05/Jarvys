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
import { fonts } from "../theme";

export default function LoginScreen() {
  const { login, register } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handle(action: "login" | "register") {
    setError(null);
    setBusy(true);
    try {
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
  title: { fontFamily: fonts.bold, fontSize: 32, textAlign: "center" },
  subtitle: { fontFamily: fonts.regular, fontSize: 14, color: "#666", textAlign: "center", marginBottom: 24 },
  label: { fontFamily: fonts.medium, fontSize: 13, color: "#444", marginTop: 12, marginBottom: 4 },
  input: {
    fontFamily: fonts.regular,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  error: { fontFamily: fonts.regular, color: "#c0392b", marginTop: 12 },
  spacing: { marginTop: 20 },
});
