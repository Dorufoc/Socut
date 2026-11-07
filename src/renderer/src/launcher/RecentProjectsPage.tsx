import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useRecentProjectsStore, selectVisibleEntries } from '../state/recentProjectsStore'
import { useUiStore } from '../state/uiStore'
import { InfoBar } from '../components/ui/InfoBar'
import { ProjectCard } from './ProjectCard'

export interface RecentProjectsPageProps {
  appVersion: string
  onOpen: (id: string) => Promise<void> | void
  onCreate: () => Promise<void> | void
  onBrowse: () => Promise<void> | void
}

const SKELETON_COUNT = 6

/**
 * 启动页（最近项目）：左侧固定导航 + 右侧可滚动的工程网格。
 * 数据源与排序/搜索规则都在 recentProjectsStore，本页只负责呈现与把动作转交 App。
 */
export function RecentProjectsPage({
  appVersion,
  onOpen,
  onCreate,
  onBrowse
}: RecentProjectsPageProps): ReactElement {
  const entries = useRecentProjectsStore((state) => state.entries)
  const loading = useRecentProjectsStore((state) => state.loading)
  const error = useRecentProjectsStore((state) => state.error)
  const sortMode = useRecentProjectsStore((state) => state.sortMode)
  const query = useRecentProjectsStore((state) => state.query)
  const refresh = useRecentProjectsStore((state) => state.refresh)
  const rename = useRecentProjectsStore((state) => state.rename)
  const remove = useRecentProjectsStore((state) => state.remove)
  const setSortMode = useRecentProjectsStore((state) => state.setSortMode)
  const setQuery = useRecentProjectsStore((state) => state.setQuery)
  const notice = useUiStore((state) => state.notice)
  const setNotice = useUiStore((state) => state.setNotice)

  const [pending, setPending] = useState<'create' | 'browse' | null>(null)

  const visible = useMemo(
    () => selectVisibleEntries({ entries, sortMode, query }),
    [entries, sortMode, query]
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runAction = async (kind: 'create' | 'browse', action: () => Promise<void> | void): Promise<void> => {
    if (pending) return
    setPending(kind)
    try {
      await action()
    } catch (failure) {
      setNotice(`操作失败：${String(failure)}`)
    } finally {
      setPending(null)
    }
  }

  const handleOpen = async (id: string): Promise<void> => {
    try {
      await onOpen(id)
    } catch (failure) {
      setNotice(`打开工程失败：${String(failure)}`)
    }
  }

  const handleCreate = (): void => {
    void runAction('create', onCreate)
  }

  const handleBrowse = (): void => {
    void runAction('browse', onBrowse)
  }

  return (
    <div className="launcher">
      <aside className="launcher__sidebar">
        <div className="launcher__brand">
          <span className="launcher__mark" aria-hidden="true">
            <span className="launcher__mark-glyph" />
          </span>
          <span className="launcher__brand-text">
            <span className="launcher__product">FocusNews</span>
            <span className="launcher__tagline">新闻视频工作台</span>
          </span>
        </div>

        <div className="launcher__primary-actions">
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={handleCreate}
            disabled={pending !== null}
          >
            {pending === 'create' ? '创建中…' : '新建工程'}
          </button>
          <button
            type="button"
            className="btn btn--subtle btn--block"
            onClick={handleBrowse}
            disabled={pending !== null}
          >
            {pending === 'browse' ? '打开中…' : '打开工程…'}
          </button>
        </div>

        <nav className="launcher__nav" aria-label="主导航">
          <button type="button" className="launcher__nav-item launcher__nav-item--active" aria-current="page">
            <span className="launcher__nav-label">最近项目</span>
            <span className="launcher__nav-badge">{entries.length}</span>
          </button>
          <button type="button" className="launcher__nav-item" disabled title="即将推出">
            <span className="launcher__nav-label">模板</span>
          </button>
          <button type="button" className="launcher__nav-item" disabled title="即将推出">
            <span className="launcher__nav-label">素材库</span>
          </button>
        </nav>

        <div className="launcher__sidebar-footer">
          <span className="launcher__version">v{appVersion}</span>
        </div>
      </aside>

      <main className="launcher__main">
        <header className="launcher__header">
          <div className="launcher__header-text">
            <h1 className="launcher__title">最近项目</h1>
            <p className="launcher__subtitle">继续未完成的工程，或开始一个新的</p>
          </div>
          <div className="launcher__header-actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleCreate}
              disabled={pending !== null}
            >
              {pending === 'create' ? '创建中…' : '新建工程'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={handleBrowse}
              disabled={pending !== null}
            >
              {pending === 'browse' ? '打开中…' : '打开工程…'}
            </button>
          </div>
        </header>

        <div className="launcher__toolbar">
          <label className="launcher__search">
            <span className="launcher__search-icon" aria-hidden="true" />
            <input
              className="input launcher__search-input"
              type="search"
              value={query}
              placeholder="搜索工程名称…"
              aria-label="搜索工程名称"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          <div className="segmented launcher__sort" role="group" aria-label="排序方式">
            <button
              type="button"
              className={`segmented__item${sortMode === 'recent' ? ' segmented__item--active' : ''}`}
              aria-pressed={sortMode === 'recent'}
              onClick={() => setSortMode('recent')}
            >
              最近使用
            </button>
            <button
              type="button"
              className={`segmented__item${sortMode === 'name' ? ' segmented__item--active' : ''}`}
              aria-pressed={sortMode === 'name'}
              onClick={() => setSortMode('name')}
            >
              名称 A→Z
            </button>
          </div>

          <span className="launcher__count">共 {visible.length} 个</span>
        </div>

        <div className="launcher__scroll">
          {notice ? (
            <InfoBar
              tone="info"
              message={notice}
              onDismiss={() => setNotice(null)}
              dismissLabel="忽略"
            />
          ) : null}

          {error ? (
            <div className="launcher__banner" role="alert">
              <span className="launcher__banner-text">{error}</span>
              <button type="button" className="btn btn--sm" onClick={() => void refresh()}>
                重试
              </button>
            </div>
          ) : null}

          {loading && entries.length === 0 ? (
            <div className="launcher__grid launcher__grid--skeleton" aria-busy="true" aria-label="正在读取最近项目">
              {Array.from({ length: SKELETON_COUNT }, (_, index) => (
                <div className="launcher__skeleton-card" key={index}>
                  <div className="launcher__skeleton-cover" />
                  <div className="launcher__skeleton-line launcher__skeleton-line--title" />
                  <div className="launcher__skeleton-line" />
                  <div className="launcher__skeleton-line launcher__skeleton-line--short" />
                </div>
              ))}
            </div>
          ) : null}

          {!loading && entries.length === 0 && !error ? (
            <div className="launcher__empty">
              <div className="launcher__empty-art" aria-hidden="true" />
              <h2 className="launcher__empty-title">还没有工程</h2>
              <p className="launcher__empty-hint">新建一个工程，或打开磁盘上已有的工程文件。</p>
              <div className="launcher__empty-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={handleCreate}
                  disabled={pending !== null}
                >
                  新建工程
                </button>
                <button type="button" className="btn" onClick={handleBrowse} disabled={pending !== null}>
                  打开已有工程
                </button>
              </div>
            </div>
          ) : null}

          {entries.length > 0 && visible.length === 0 ? (
            <div className="launcher__empty launcher__empty--filtered">
              <h2 className="launcher__empty-title">没有匹配“{query}”的工程</h2>
              <button type="button" className="btn btn--sm" onClick={() => setQuery('')}>
                清除搜索
              </button>
            </div>
          ) : null}

          {visible.length > 0 ? (
            <div className="launcher__grid">
              {visible.map((entry) => (
                <ProjectCard
                  key={entry.id}
                  entry={entry}
                  onOpen={(id) => void handleOpen(id)}
                  onRename={rename}
                  onRemove={remove}
                />
              ))}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  )
}
