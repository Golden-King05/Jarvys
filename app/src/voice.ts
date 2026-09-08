import { Platform } from "react-native";
import { File } from "expo-file-system";
import * as Speech from "expo-speech";

export interface RecordingResult {
  base64: string;
  mimeType: string;
}

export async function readRecordingAsBase64(uri: string): Promise<RecordingResult> {
  const mimeType = Platform.OS === "web" ? "audio/webm" : "audio/m4a";

  if (Platform.OS === "web") {
    const response = await fetch(uri);
    const blob = await response.blob();
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string).split(",")[1] ?? "");
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    return { base64, mimeType };
  }

  const base64 = await new File(uri).base64();
  return { base64, mimeType };
}

export function speak(text: string): void {
  if (Platform.OS === "web") {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    return;
  }
  Speech.stop();
  Speech.speak(text);
}

export function stopSpeaking(): void {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    return;
  }
  Speech.stop();
}
