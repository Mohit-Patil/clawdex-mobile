import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type { GitStatusResponse } from '../api/types';

interface GitScreenProps {
  api: MacBridgeApiClient;
}

export function GitScreen({ api }: GitScreenProps) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [diff, setDiff] = useState('');
  const [commitMessage, setCommitMessage] = useState('chore: checkpoint');
  const [loading, setLoading] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const [nextStatus, nextDiff] = await Promise.all([
        api.gitStatus(),
        api.gitDiff()
      ]);

      setStatus(nextStatus);
      setDiff(nextDiff.diff);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const commit = useCallback(async () => {
    try {
      setCommitting(true);
      const result = await api.gitCommit({ message: commitMessage });
      if (!result.committed) {
        setError(result.stderr || 'Commit command failed.');
      } else {
        setError(null);
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCommitting(false);
    }
  }, [api, commitMessage, refresh]);

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Repository</Text>
        <Button title="Refresh" onPress={() => void refresh()} />
      </View>

      <Text style={styles.meta}>Branch: {status?.branch ?? 'unknown'}</Text>
      <Text style={styles.meta}>Clean: {status?.clean ? 'yes' : 'no'}</Text>

      <Text style={styles.title}>Commit</Text>
      <TextInput
        value={commitMessage}
        onChangeText={setCommitMessage}
        style={styles.input}
        placeholder="Commit message"
      />
      <Button
        title={committing ? 'Committing...' : 'Commit'}
        onPress={() => void commit()}
        disabled={committing || !commitMessage.trim()}
      />

      <Text style={styles.title}>Diff</Text>
      <ScrollView style={styles.diffBox} contentContainerStyle={styles.diffContent}>
        <Text style={styles.diffText}>{diff || 'No diff.'}</Text>
      </ScrollView>

      {error ? <Text style={styles.error}>Error: {error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  container: {
    flex: 1,
    padding: 16,
    gap: 10
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  title: {
    fontWeight: '600',
    fontSize: 16
  },
  meta: {
    color: '#475569'
  },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  diffBox: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#0f172a'
  },
  diffContent: {
    padding: 12
  },
  diffText: {
    color: '#e2e8f0',
    fontFamily: 'Courier'
  },
  error: {
    color: '#b91c1c'
  }
});
