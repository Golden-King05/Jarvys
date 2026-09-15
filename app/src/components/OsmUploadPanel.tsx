import React, { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { api, type OsmUploadResult, type OsmUploadTarget } from "../api";
import { useAuth } from "../AuthContext";
import { fonts } from "../theme";
import { clearOsmToken, getOsmToken, osmTargetStorage, useOsmOAuthRequest } from "../utils/osmAuth";
import { OSM_TARGET_LABELS } from "../utils/osmConfig";

interface OsmUploadPanelProps {
  dirtyCount: number;
  onUploaded: (result: OsmUploadResult) => void;
  onClose: () => void;
}

// The upload panel for JLOSME's changeset flow: target toggle (sandbox
// default, per the safety decision baked into this whole feature), OSM
// OAuth2 login, a required changeset comment, and the upload action itself.
export default function OsmUploadPanel({ dirtyCount, onUploaded, onClose }: OsmUploadPanelProps) {
  const { baseUrl, token } = useAuth();
  const [target, setTarget] = useState<OsmUploadTarget>("sandbox");
  const [osmToken, setOsmToken] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const { canLogin, login } = useOsmOAuthRequest(target);

  useEffect(() => {
    osmTargetStorage.get().then((stored) => {
      if (stored === "sandbox" || stored === "production") setTarget(stored);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    getOsmToken(target).then((t) => {
      if (!cancelled) setOsmToken(t);
    });
    return () => {
      cancelled = true;
    };
  }, [target]);

  function selectTarget(next: OsmUploadTarget) {
    setTarget(next);
    osmTargetStorage.set(next);
    setStatus(null);
  }

  async function handleLogin() {
    setStatus(null);
    setLoggingIn(true);
    try {
      const newToken = await login();
      if (newToken) setOsmToken(newToken);
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Login failed" });
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleLogout() {
    await clearOsmToken(target);
    setOsmToken(null);
  }

  async function handleUpload() {
    if (!token || !osmToken || !comment.trim()) return;
    setUploading(true);
    setStatus(null);
    try {
      const result = await api.uploadOsmChangeset(baseUrl, token, osmToken, { target, comment: comment.trim() });
      setStatus({
        kind: "ok",
        message: `Uploaded as changeset #${result.changesetId} — ${result.created} created, ${result.modified} modified, ${result.deleted} deleted.`,
      });
      setComment("");
      onUploaded(result);
    } catch (e) {
      // A 409 version conflict (or any other OSM API error) lands here as
      // plain text straight from the OSM API — surfaced as-is rather than
      // reworded, since that's already the clearest available explanation
      // (e.g. "Version mismatch: Provided 1, server had: 2 of Node 123").
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Upload failed" });
    } finally {
      setUploading(false);
    }
  }

  const canUpload = Boolean(osmToken) && comment.trim().length > 0 && dirtyCount > 0 && !uploading;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Upload to OpenStreetMap</Text>
        <TouchableOpacity onPress={onClose} hitSlop={8}>
          <Text style={styles.closeText}>✕</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.label}>Target</Text>
      {(["sandbox", "production"] as OsmUploadTarget[]).map((t) => (
        <TouchableOpacity key={t} style={styles.targetRow} onPress={() => selectTarget(t)}>
          <View style={[styles.radio, target === t && styles.radioSelected]} />
          <Text style={styles.targetLabel}>{OSM_TARGET_LABELS[t]}</Text>
        </TouchableOpacity>
      ))}

      {osmToken ? (
        <View style={styles.loggedInRow}>
          <Text style={styles.loggedInText}>Logged in to OpenStreetMap ({target}).</Text>
          <TouchableOpacity onPress={handleLogout}>
            <Text style={styles.logoutText}>Log out</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity style={styles.loginButton} onPress={handleLogin} disabled={loggingIn || !canLogin}>
          {loggingIn ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.loginButtonText}>Log in to OpenStreetMap</Text>
          )}
        </TouchableOpacity>
      )}
      {!canLogin ? (
        <Text style={styles.hint}>
          No OAuth client ID configured yet for {target} — an app must be registered on OpenStreetMap first (see
          app/src/utils/osmConfig.ts).
        </Text>
      ) : null}

      <Text style={styles.label}>Changeset comment (required)</Text>
      <TextInput
        style={styles.commentInput}
        placeholder="What did you change and why?"
        value={comment}
        onChangeText={setComment}
        multiline
      />

      <Text style={styles.pendingText}>
        {dirtyCount} pending edit{dirtyCount === 1 ? "" : "s"}
      </Text>

      <TouchableOpacity
        style={[styles.uploadButton, !canUpload && styles.uploadButtonDisabled]}
        onPress={handleUpload}
        disabled={!canUpload}
      >
        {uploading ? <ActivityIndicator color="#fff" /> : <Text style={styles.uploadButtonText}>Upload changeset</Text>}
      </TouchableOpacity>

      {status ? <Text style={status.kind === "error" ? styles.errorText : styles.okText}>{status.message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 14 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  title: { fontFamily: fonts.semiBold, fontSize: 15, color: "#222" },
  closeText: { fontSize: 16, color: "#888" },
  label: { fontFamily: fonts.medium, fontSize: 13, color: "#444", marginTop: 10, marginBottom: 6 },
  targetRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  radio: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: "#bbb" },
  radioSelected: { borderColor: "#2980b9", backgroundColor: "#2980b9" },
  targetLabel: { fontFamily: fonts.regular, fontSize: 13, color: "#333", flexShrink: 1 },
  loggedInRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 },
  loggedInText: { fontFamily: fonts.regular, fontSize: 12, color: "#27ae60" },
  logoutText: { fontFamily: fonts.medium, fontSize: 12, color: "#888" },
  loginButton: {
    backgroundColor: "#2980b9",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
    marginTop: 8,
  },
  loginButtonText: { fontFamily: fonts.medium, fontSize: 13, color: "#fff" },
  hint: { fontFamily: fonts.regular, fontSize: 11, color: "#999", marginTop: 6 },
  commentInput: {
    fontFamily: fonts.regular,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    minHeight: 60,
    textAlignVertical: "top",
  },
  pendingText: { fontFamily: fonts.regular, fontSize: 12, color: "#888", marginTop: 8 },
  uploadButton: {
    backgroundColor: "#27ae60",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 10,
  },
  uploadButtonDisabled: { backgroundColor: "#bbb" },
  uploadButtonText: { fontFamily: fonts.semiBold, fontSize: 14, color: "#fff" },
  errorText: { fontFamily: fonts.regular, fontSize: 12, color: "#c0392b", marginTop: 10 },
  okText: { fontFamily: fonts.regular, fontSize: 12, color: "#27ae60", marginTop: 10 },
});
