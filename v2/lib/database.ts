import { ParseRule, OrderItem } from '../types';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json();
  if (!data?.ok) throw new Error(data?.error || `请求失败 ${res.status}`);
  return data as T;
}

export async function getAllRules(): Promise<ParseRule[]> {
  const data = await apiFetch<{ rules: ParseRule[] }>('/api/v2/rules');
  return data.rules;
}

export async function getRuleById(id: string): Promise<ParseRule | null> {
  try {
    const data = await apiFetch<{ rule: ParseRule }>(`/api/v2/rules/${id}`);
    return data.rule;
  } catch {
    return null;
  }
}

export async function saveRule(rule: ParseRule): Promise<boolean> {
  try {
    await apiFetch('/api/v2/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rule),
    });
    return true;
  } catch {
    return false;
  }
}

export async function deleteRule(id: string): Promise<boolean> {
  try {
    await apiFetch(`/api/v2/rules/${id}`, { method: 'DELETE' });
    return true;
  } catch {
    return false;
  }
}

export async function getAllOrders(
  page = 1,
  pageSize = 10,
  searchTerm = '',
  searchField = '',
  startDate = '',
  endDate = ''
): Promise<{ list: OrderItem[]; total: number }> {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    searchTerm,
    searchField,
    startDate,
    endDate,
  });
  const data = await apiFetch<{ list: OrderItem[]; total: number }>(`/api/v2/orders?${params}`);
  return { list: data.list, total: data.total };
}

export async function saveOrderItems(items: OrderItem[]): Promise<{ success: number; failed: number; duplicates: number }> {
  const data = await apiFetch<{ success: number; failed: number; duplicates: number }>('/api/v2/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  return { success: data.success, failed: data.failed, duplicates: data.duplicates };
}

export async function checkDuplicateExternalCodes(codes: string[]): Promise<Set<string>> {
  const data = await apiFetch<{ duplicates: string[] }>('/api/v2/orders/check-duplicates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes }),
  });
  return new Set(data.duplicates);
}
