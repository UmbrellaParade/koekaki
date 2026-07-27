import type { HistoryItem } from './types'

/**
 * 履歴は IndexedDB に持つ。音声そのものは保存しない（テキストのみ）。
 * localStorage だと数百件で容量が厳しくなるため。
 */

const DB_NAME = 'koekaki'
const DB_VERSION = 1
const STORE = 'history'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('履歴データベースを開けませんでした'))
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode)
        const req = fn(transaction.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('履歴の操作に失敗しました'))
      }),
  )
}

export async function addHistory(item: HistoryItem): Promise<void> {
  await tx('readwrite', (store) => store.put(item))
}

export async function listHistory(limit = 300): Promise<HistoryItem[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE)
    const index = store.index('createdAt')
    const items: HistoryItem[] = []
    const req = index.openCursor(null, 'prev')
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor && items.length < limit) {
        items.push(cursor.value as HistoryItem)
        cursor.continue()
      } else {
        resolve(items)
      }
    }
    req.onerror = () => reject(req.error ?? new Error('履歴の読み込みに失敗しました'))
  })
}

export async function deleteHistory(id: string): Promise<void> {
  await tx('readwrite', (store) => store.delete(id))
}

export async function clearHistory(): Promise<void> {
  await tx('readwrite', (store) => store.clear())
}

export function historyToMarkdown(items: HistoryItem[]): string {
  const lines = ['# こえかき 履歴', '']
  for (const item of items) {
    const date = new Date(item.createdAt).toLocaleString('ja-JP')
    lines.push(`## ${date} — ${item.modeName}`, '', item.polished, '')
    if (item.raw && item.raw !== item.polished) {
      lines.push('<details><summary>元の書き起こし</summary>', '', item.raw, '', '</details>', '')
    }
    lines.push('---', '')
  }
  return lines.join('\n')
}
