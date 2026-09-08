import React, { useState } from "react";
import { Button, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import { readRecordingAsBase64, speak, stopSpeaking } from "../voice";

interface Message {
  from: "you" | "assistant";
  text: string;
}

export default function HomeScreen() {
  const { baseUrl, token } = useAuth();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder);

  async function sendMessage(text: string) {
    if (!text.trim() || !token) return;
    setError(null);
    setMessages((prev) => [...prev, { from: "you", text }]);
    try {
      const { reply } = await api.chat(baseUrl, token, text);
      setMessages((prev) => [...prev, { from: "assistant", text: reply }]);
      if (!muted) speak(reply);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send message");
    }
  }

  async function send() {
    if (!input.trim()) return;
    const text = input.trim();
    setInput("");
    await sendMessage(text);
  }

  async function toggleRecording() {
    setError(null);
    if (recorderState.isRecording) {
      setBusy(true);
      try {
        await audioRecorder.stop();
        const uri = audioRecorder.uri;
        if (!uri) throw new Error("Recording produced no audio file");
        const { base64, mimeType } = await readRecordingAsBase64(uri);
        if (!token) return;
        const { text } = await api.transcribe(baseUrl, token, base64, mimeType);
        await sendMessage(text);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Voice input failed");
      } finally {
        setBusy(false);
      }
    } else {
      try {
        const permission = await AudioModule.requestRecordingPermissionsAsync();
        if (!permission.granted) {
          throw new Error("Microphone permission is required to talk to the assistant.");
        }
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await audioRecorder.prepareToRecordAsync();
        audioRecorder.record();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not start recording");
      }
    }
  }

  function toggleMuted() {
    if (!muted) stopSpeaking();
    setMuted((m) => !m);
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
        {busy ? <Text style={styles.placeholder}>Listening...</Text> : null}
      </ScrollView>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.voiceRow}>
        <Button
          title={recorderState.isRecording ? "Stop" : "Talk"}
          color={recorderState.isRecording ? "#c0392b" : undefined}
          onPress={toggleRecording}
          disabled={busy}
        />
        <Button title={muted ? "Unmute replies" : "Mute replies"} onPress={toggleMuted} />
      </View>

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Or type a message"
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
  voiceRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 12,
    paddingTop: 12,
    paddingBottom: 4,
    borderTopWidth: 1,
    borderTopColor: "#eee",
  },
  inputRow: {
    flexDirection: "row",
    padding: 12,
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
