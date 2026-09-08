import React, { useState } from "react";
import { Button, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { api } from "../api";
import { useAuth } from "../AuthContext";

interface Message {
  from: "you" | "assistant";
  text: string;
}

export default function HomeScreen() {
  const { baseUrl, token } = useAuth();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!input.trim() || !token) return;
    const text = input.trim();
    setInput("");
    setError(null);
    setMessages((prev) => [...prev, { from: "you", text }]);
    try {
      const { reply } = await api.chat(baseUrl, token, text);
      setMessages((prev) => [...prev, { from: "assistant", text: reply }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send message");
    }
  }

  return (
    <View style={styles.container}>
      <ScrollView style={styles.messages} contentContainerStyle={{ padding: 16 }}>
        {messages.length === 0 ? (
          <Text style={styles.placeholder}>Say something to your assistant.</Text>
        ) : null}
        {messages.map((m, i) => (
          <Text key={i} style={m.from === "you" ? styles.you : styles.assistant}>
            {m.from === "you" ? "You: " : ""}
            {m.text}
          </Text>
        ))}
      </ScrollView>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Type a message"
          onSubmitEditing={send}
        />
        <Button title="Send" onPress={send} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  messages: { flex: 1 },
  placeholder: { color: "#888", textAlign: "center", marginTop: 40 },
  you: { marginBottom: 8, fontWeight: "600" },
  assistant: { marginBottom: 8 },
  error: { color: "#c0392b", paddingHorizontal: 16 },
  inputRow: {
    flexDirection: "row",
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: "#eee",
    gap: 8,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
});
