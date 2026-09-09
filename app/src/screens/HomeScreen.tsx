import React, { useEffect, useState } from "react";
import { ActivityIndicator, Button, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { api, type Provider } from "../api";
import { useAuth } from "../AuthContext";
import { readRecordingAsBase64, speak, stopSpeaking } from "../voice";
import { fonts } from "../theme";

interface Message {
  from: "you" | "assistant" | "system";
  text: string;
}

interface UsageState {
  promptTokens: number;
  contextWindow: number;
}

interface RateLimitState {
  limitRequests: number;
  remainingRequests: number;
}

interface PendingThinking {
  originalMessage: string;
  reason: string;
}

// Matches the server's COMPRESSION_THRESHOLD_RATIO (server/src/llm.ts) — kept
// here only to estimate "messages until compression" for display, not to
// decide anything.
const COMPRESSION_THRESHOLD_RATIO = 0.75;

export default function HomeScreen() {
  const { baseUrl, token } = useAuth();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [rateLimit, setRateLimit] = useState<RateLimitState | null>(null);
  const [promptTokenHistory, setPromptTokenHistory] = useState<number[]>([]);
  const [pendingThinking, setPendingThinking] = useState<PendingThinking | null>(null);
  const [resolvingThinking, setResolvingThinking] = useState(false);
  const [lastProvider, setLastProvider] = useState<Provider | null>(null);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder);

  // Load the account's saved conversation on open, so it survives a refresh
  // or picks up where another device left off.
  useEffect(() => {
    if (!token) return;
    api
      .getMessages(baseUrl, token)
      .then(({ messages: stored }) => {
        setMessages(stored.map((m) => ({ from: m.role === "user" ? "you" : "assistant", text: m.content })));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load conversation"))
      .finally(() => setLoadingHistory(false));
  }, [baseUrl, token]);

  // Sends `text` to the assistant and applies whatever comes back — a normal
  // reply, or a request to think harder first (handled by the caller).
  async function requestReply(text: string, forceReasoningEffort?: "default" | "none") {
    if (!token) return;
    const result = await api.chat(baseUrl, token, text, forceReasoningEffort);

    if (result.thinkingRequest) {
      setPendingThinking({ originalMessage: text, reason: result.thinkingRequest.reason });
      return;
    }

    if (result.provider && lastProvider !== null && result.provider !== lastProvider) {
      const switchText =
        result.provider === "gemini"
          ? (result.providerNote ?? "Switched to Gemini for this reply.")
          : "Back to Groq.";
      setMessages((prev) => [...prev, { from: "system", text: switchText }]);
    }
    if (result.provider) setLastProvider(result.provider);

    setMessages((prev) => [...prev, { from: "assistant", text: result.reply! }]);
    if (!muted) speak(result.reply!);

    if (result.usage) {
      setUsage({ promptTokens: result.usage.promptTokens, contextWindow: result.usage.contextWindow });
      setPromptTokenHistory((prev) =>
        result.compressed ? [result.usage!.promptTokens] : [...prev, result.usage!.promptTokens]
      );
    }
    if (result.rateLimit) {
      setRateLimit(result.rateLimit);
    }
    if (result.compressed) {
      setMessages((prev) => [
        ...prev,
        {
          from: "system",
          text: `Context was getting long — trimmed ${result.droppedMessages} older message(s) to make room.`,
        },
      ]);
    }
  }

  async function sendMessage(text: string) {
    if (!text.trim() || !token) return;
    setError(null);
    setPendingThinking(null);
    setMessages((prev) => [...prev, { from: "you", text }]);
    try {
      await requestReply(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send message");
    }
  }

  async function resolveThinking(choice: "default" | "none") {
    if (!pendingThinking) return;
    setError(null);
    setResolvingThinking(true);
    const { originalMessage } = pendingThinking;
    setPendingThinking(null);
    try {
      await requestReply(originalMessage, choice);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      setResolvingThinking(false);
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

  const usagePercent = usage ? Math.min(100, (usage.promptTokens / usage.contextWindow) * 100) : 0;
  const barColor = usagePercent > 90 ? "#c0392b" : usagePercent > 70 ? "#e67e22" : "#27ae60";

  let messagesLeftLabel = "";
  if (usage && promptTokenHistory.length >= 2) {
    const first = promptTokenHistory[0];
    const last = promptTokenHistory[promptTokenHistory.length - 1];
    const avgGrowthPerMessage = (last - first) / (promptTokenHistory.length - 1);
    const threshold = usage.contextWindow * COMPRESSION_THRESHOLD_RATIO;
    if (avgGrowthPerMessage > 0) {
      const remaining = Math.max(0, Math.ceil((threshold - last) / avgGrowthPerMessage));
      messagesLeftLabel = `~${remaining} message${remaining === 1 ? "" : "s"} until context is trimmed (estimate)`;
    }
  } else if (usage) {
    messagesLeftLabel = "Estimating... send a couple more messages";
  }

  const rateLimitPercent = rateLimit
    ? Math.min(100, (rateLimit.remainingRequests / rateLimit.limitRequests) * 100)
    : 0;

  if (loadingHistory) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {usage ? (
        <View style={styles.usageBox}>
          <View style={styles.usageBarTrack}>
            <View style={[styles.usageBarFill, { width: `${usagePercent}%`, backgroundColor: barColor }]} />
          </View>
          <Text style={styles.usageText}>
            {usage.promptTokens.toLocaleString()} / {usage.contextWindow.toLocaleString()} tokens (
            {usagePercent.toFixed(1)}%)
          </Text>
          {messagesLeftLabel ? <Text style={styles.usageSubtext}>{messagesLeftLabel}</Text> : null}

          {rateLimit ? (
            <>
              <Text style={[styles.usageText, styles.rateLimitLabel]}>
                {rateLimit.remainingRequests.toLocaleString()} / {rateLimit.limitRequests.toLocaleString()}{" "}
                messages left today (Groq's free-tier daily limit)
              </Text>
              <View style={styles.usageBarTrack}>
                <View
                  style={[
                    styles.usageBarFill,
                    {
                      width: `${rateLimitPercent}%`,
                      backgroundColor: rateLimitPercent < 10 ? "#c0392b" : "#2980b9",
                    },
                  ]}
                />
              </View>
            </>
          ) : null}
        </View>
      ) : null}

      <ScrollView style={styles.messages} contentContainerStyle={{ padding: 16 }}>
        {messages.length === 0 ? (
          <Text style={styles.placeholder}>Say something to your assistant.</Text>
        ) : null}
        {messages.map((m, i) => (
          <Text
            key={i}
            style={m.from === "you" ? styles.you : m.from === "system" ? styles.system : styles.assistant}
          >
            {m.from === "you" ? "You: " : ""}
            {m.text}
          </Text>
        ))}
        {busy ? <Text style={styles.placeholder}>Listening...</Text> : null}
      </ScrollView>

      {pendingThinking ? (
        <View style={styles.thinkingBox}>
          <Text style={styles.thinkingText}>{pendingThinking.reason}</Text>
          <Text style={styles.thinkingSubtext}>Think it through more carefully before answering?</Text>
          {resolvingThinking ? (
            <ActivityIndicator style={styles.spacing} />
          ) : (
            <View style={styles.thinkingButtons}>
              <Button title="Yes, think it through" onPress={() => resolveThinking("default")} />
              <Button title="No, quick answer" onPress={() => resolveThinking("none")} />
            </View>
          )}
        </View>
      ) : null}

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
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  messages: { flex: 1 },
  placeholder: { fontFamily: fonts.regular, color: "#888", textAlign: "center", marginTop: 40 },
  you: { fontFamily: fonts.semiBold, marginBottom: 8 },
  assistant: { fontFamily: fonts.regular, marginBottom: 8 },
  system: { fontFamily: fonts.regular, marginBottom: 8, fontStyle: "italic", color: "#888", fontSize: 12 },
  error: { fontFamily: fonts.regular, color: "#c0392b", paddingHorizontal: 16 },
  usageBox: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  usageBarTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: "#eee",
    overflow: "hidden",
  },
  usageBarFill: {
    height: "100%",
    borderRadius: 3,
  },
  usageText: { fontFamily: fonts.medium, fontSize: 12, color: "#444", marginTop: 4 },
  usageSubtext: { fontFamily: fonts.regular, fontSize: 11, color: "#888", marginTop: 1 },
  rateLimitLabel: { marginTop: 10 },
  thinkingBox: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 8,
    backgroundColor: "#fff8e6",
    borderWidth: 1,
    borderColor: "#f0d99a",
  },
  thinkingText: { fontFamily: fonts.medium, fontSize: 13, color: "#6b5a17" },
  thinkingSubtext: { fontFamily: fonts.regular, fontSize: 12, color: "#8a6d1d", marginTop: 4, marginBottom: 10 },
  thinkingButtons: { flexDirection: "row", gap: 12 },
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
    fontFamily: fonts.regular,
    flex: 1,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  spacing: { marginTop: 4 },
});
