import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { RepositoryError } from "./conversations";

export type MemoryCategory = "preference" | "fact" | "work" | "personal" | "general";

export interface UserMemory {
  id: string;
  userId: string;
  content: string;
  category: MemoryCategory;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryMatch {
  id: string;
  content: string;
  category: MemoryCategory;
  similarity: number;
  createdAt: string;
}

export interface NewMemory {
  content: string;
  category?: MemoryCategory;
  embedding: number[];
}

export interface MemoryRepository {
  listMemories(
    userId: string,
    options?: { category?: MemoryCategory; limit?: number; offset?: number },
  ): Promise<UserMemory[]>;
  getMemory(userId: string, memoryId: string): Promise<UserMemory | null>;
  createMemory(userId: string, memory: NewMemory): Promise<UserMemory>;
  deleteMemory(userId: string, memoryId: string): Promise<boolean>;
  searchMemories(
    userId: string,
    queryEmbedding: number[],
    options?: { threshold?: number; limit?: number; category?: MemoryCategory },
  ): Promise<MemoryMatch[]>;
}

const memoryCategorySchema = z.enum(["preference", "fact", "work", "personal", "general"]);

const memoryRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  content: z.string(),
  category: memoryCategorySchema,
  created_at: z.string(),
  updated_at: z.string(),
});

const memoryMatchRowSchema = z.object({
  id: z.string(),
  content: z.string(),
  category: memoryCategorySchema,
  similarity: z.number(),
  created_at: z.string(),
});

function toUserMemory(row: unknown): UserMemory {
  const parsed = memoryRowSchema.parse(row);
  return {
    id: parsed.id,
    userId: parsed.user_id,
    content: parsed.content,
    category: parsed.category,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
}

export function createMemoryRepository(supabase: SupabaseClient): MemoryRepository {
  return {
    async listMemories(userId: string, options = {}): Promise<UserMemory[]> {
      let query = supabase
        .from("user_memories")
        .select("id, user_id, content, category, created_at, updated_at")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false });

      if (options.category) {
        query = query.eq("category", options.category);
      }
      if (options.limit) {
        const offset = options.offset ?? 0;
        query = query.range(offset, offset + options.limit - 1);
      }

      const { data, error } = await query;
      if (error) throw new RepositoryError("listMemories");
      return (data ?? []).map(toUserMemory);
    },

    async getMemory(userId: string, memoryId: string): Promise<UserMemory | null> {
      const { data, error } = await supabase
        .from("user_memories")
        .select("id, user_id, content, category, created_at, updated_at")
        .eq("id", memoryId)
        .eq("user_id", userId)
        .maybeSingle();

      if (error) throw new RepositoryError("getMemory");
      return data ? toUserMemory(data) : null;
    },

    async createMemory(userId: string, memory: NewMemory): Promise<UserMemory> {
      const category = memory.category ?? "general";
      const { data, error } = await supabase
        .from("user_memories")
        .insert({
          user_id: userId,
          content: memory.content.trim(),
          category,
          embedding: memory.embedding,
        })
        .select("id, user_id, content, category, created_at, updated_at")
        .single();

      if (error || !data) throw new RepositoryError("createMemory");
      return toUserMemory(data);
    },

    async deleteMemory(userId: string, memoryId: string): Promise<boolean> {
      const { data, error } = await supabase
        .from("user_memories")
        .delete()
        .eq("id", memoryId)
        .eq("user_id", userId)
        .select("id");

      if (error) throw new RepositoryError("deleteMemory");
      return Boolean(data && data.length > 0);
    },

    async searchMemories(
      userId: string,
      queryEmbedding: number[],
      options = {},
    ): Promise<MemoryMatch[]> {
      const threshold = options.threshold ?? 0.2;
      const limit = options.limit ?? 5;
      const category = options.category ?? null;

      const { data, error } = await supabase.rpc("match_user_memories", {
        p_query_embedding: queryEmbedding,
        p_match_threshold: threshold,
        p_match_count: limit,
        p_category: category,
      });

      if (error) {
        throw new RepositoryError("searchMemories");
      }

      return (data ?? []).map((row: unknown) => {
        const parsed = memoryMatchRowSchema.parse(row);
        return {
          id: parsed.id,
          content: parsed.content,
          category: parsed.category,
          similarity: parsed.similarity,
          createdAt: parsed.created_at,
        };
      });
    },
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const valA = a[i]!;
    const valB = b[i]!;
    dot += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function createMockMemoryRepository(
  initialMemories: Array<{
    id?: string;
    userId: string;
    content: string;
    category?: MemoryCategory;
    embedding: number[];
    createdAt?: string;
    updatedAt?: string;
  }> = [],
): MemoryRepository {
  interface StoredMemory {
    id: string;
    userId: string;
    content: string;
    category: MemoryCategory;
    embedding: number[];
    createdAt: string;
    updatedAt: string;
  }

  const memories: StoredMemory[] = initialMemories.map((m) => {
    const now = new Date().toISOString();
    return {
      id: m.id ?? crypto.randomUUID(),
      userId: m.userId,
      content: m.content,
      category: m.category ?? "general",
      embedding: m.embedding,
      createdAt: m.createdAt ?? now,
      updatedAt: m.updatedAt ?? now,
    };
  });

  return {
    async listMemories(userId: string, options = {}): Promise<UserMemory[]> {
      let filtered = memories
        .filter((m) => m.userId === userId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

      if (options.category) {
        filtered = filtered.filter((m) => m.category === options.category);
      }
      if (options.limit) {
        const offset = options.offset ?? 0;
        filtered = filtered.slice(offset, offset + options.limit);
      }

      return filtered.map(({ id, userId: uId, content, category, createdAt, updatedAt }) => ({
        id,
        userId: uId,
        content,
        category,
        createdAt,
        updatedAt,
      }));
    },

    async getMemory(userId: string, memoryId: string): Promise<UserMemory | null> {
      const found = memories.find((m) => m.id === memoryId && m.userId === userId);
      if (!found) return null;
      return {
        id: found.id,
        userId: found.userId,
        content: found.content,
        category: found.category,
        createdAt: found.createdAt,
        updatedAt: found.updatedAt,
      };
    },

    async createMemory(userId: string, newMem: NewMemory): Promise<UserMemory> {
      const now = new Date().toISOString();
      const stored: StoredMemory = {
        id: crypto.randomUUID(),
        userId,
        content: newMem.content.trim(),
        category: newMem.category ?? "general",
        embedding: newMem.embedding,
        createdAt: now,
        updatedAt: now,
      };
      memories.push(stored);
      return {
        id: stored.id,
        userId: stored.userId,
        content: stored.content,
        category: stored.category,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
      };
    },

    async deleteMemory(userId: string, memoryId: string): Promise<boolean> {
      const idx = memories.findIndex((m) => m.id === memoryId && m.userId === userId);
      if (idx === -1) return false;
      memories.splice(idx, 1);
      return true;
    },

    async searchMemories(
      userId: string,
      queryEmbedding: number[],
      options = {},
    ): Promise<MemoryMatch[]> {
      const threshold = options.threshold ?? 0.2;
      const limit = options.limit ?? 5;
      const category = options.category;

      const matches: MemoryMatch[] = [];
      for (const m of memories) {
        if (m.userId !== userId) continue;
        if (category && m.category !== category) continue;
        const sim = cosineSimilarity(queryEmbedding, m.embedding);
        if (sim >= threshold) {
          matches.push({
            id: m.id,
            content: m.content,
            category: m.category,
            similarity: Math.round(sim * 10000) / 10000,
            createdAt: m.createdAt,
          });
        }
      }

      return matches.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
    },
  };
}
