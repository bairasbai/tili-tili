import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react'
import { AssistantRuntimeProvider } from '@assistant-ui/core/react'
import { t } from '@/lib/i18n'
import { ApiError } from '@/lib/api/client'
import { formatWeddingDate } from '@/lib/weddingDate'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'
import type { components } from '@/lib/api/schema'

export type TillyActionView = components['schemas']['TillyAction']
type CardsProps = { weddingId: string; messageId: string; actions: TillyActionView[]; accept: (id: string, assertCurrent: () => void) => Promise<TillyActionView> }
const CardsContext = createContext<CardsProps | null>(null)
function ActionTool({ toolCallId }: { toolCallId: string }) {
  const context = useContext(CardsContext)
  const action = context?.actions.find(value => value.id === toolCallId)
  return context && action ? <ActionCard key={action.id} weddingId={context.weddingId} action={action} accept={context.accept} /> : null
}
function ActionMessage() {
  return <MessagePrimitive.Root className="space-y-3"><MessagePrimitive.Parts components={{ tools: { by_name: { tilly_task: ActionTool }, Fallback: () => null } }} /></MessagePrimitive.Root>
}

/** Display-only bridge for the existing server message; it creates no chat transport or tools. */
export function TillyActionCards(props: CardsProps) {
  const sessionKey = useLegacySessionKey(props.weddingId)
  return <CardsSession key={`${props.weddingId}:${props.messageId}:${sessionKey}`} {...props} />
}
function CardsSession(props: CardsProps) {
  const messages = useMemo<ThreadMessageLike[]>(() => [{
    id: props.messageId, role: 'assistant',
    content: props.actions.map(action => ({ type: 'tool-call', toolCallId: action.id, toolName: 'tilly_task', args: { actionId: action.id }, argsText: JSON.stringify({ actionId: action.id }), ...(action.state !== 'pending' ? { result: { state: action.state } } : {}) })),
    status: { type: 'complete', reason: 'stop' },
  }], [props.messageId, props.actions])
  const runtime = useExternalStoreRuntime({ messages, convertMessage: message => message, isRunning: false, isDisabled: true, unstable_enableToolInvocations: false, onNew: async () => { throw new Error('Existing chat composer owns sending') } })
  return <div className="mt-3 min-w-0"><AssistantRuntimeProvider runtime={runtime}><CardsContext.Provider value={props}><ThreadPrimitive.Root><ThreadPrimitive.Viewport autoScroll={false} scrollToBottomOnInitialize={false} scrollToBottomOnRunStart={false} scrollToBottomOnThreadSwitch={false}><ThreadPrimitive.Messages components={{ AssistantMessage: ActionMessage, UserMessage: () => null }} /></ThreadPrimitive.Viewport></ThreadPrimitive.Root></CardsContext.Provider></AssistantRuntimeProvider></div>
}
function ActionCard({ weddingId, action, accept }: { weddingId: string; action: TillyActionView; accept: CardsProps['accept'] }) {
  const [result, setResult] = useState<TillyActionView | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const operation = useRef<object | null>(null), alive = useRef(true)
  // A chat can belong to another authorized wedding than the profile's current selection.
  // Its server-confirmed wedding/message and session remount own this action scope.
  const session = useLegacySessionKey(weddingId), captureAccess = useLegacyActionScope(session)
  const shown = result ?? action
  const expired = shown.state === 'pending' && Date.parse(shown.expiresAt) <= now
  const showPreview = shown.state === 'pending' && shown.canApply && !expired
  useEffect(() => {
    const delay = Date.parse(shown.expiresAt) - now
    if (shown.state !== 'pending' || delay <= 0 || !Number.isFinite(delay)) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(delay + 1, 2_147_483_647))
    return () => clearTimeout(timer)
  }, [shown.state, shown.expiresAt, now])
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current = null } }, [])
  async function confirm() {
    if (operation.current || shown.state !== 'pending' || expired || !shown.canApply) return
    let access: ReturnType<typeof captureAccess>
    try { access = captureAccess() } catch { return }
    if (!window.confirm(t('Применить это изменение в чек-листе?'))) return
    if (!access.isCurrent()) return
    const request = {}; operation.current = request; setBusy(true); setError('')
    const current = () => alive.current && operation.current === request && access.isCurrent()
    try { const response = await accept(shown.id, access.assertCurrent); if (current() && response.id === shown.id) setResult(response) }
    catch (error) {
      if (!current()) return
      if (error instanceof ApiError && error.status === 409) { setResult({ ...shown, state: 'stale', canApply: false }); setError(t('Предложение устарело. Попроси Тиля подготовить новое.')) }
      else setError(t('Не удалось применить. Повтори — изменение не выполнится дважды.'))
    } finally { if (operation.current === request) { operation.current = null; if (alive.current) setBusy(false) } }
  }
  const title = shown.kind === 'create_task' ? t('Добавить задачу') : shown.kind === 'complete_task' ? t('Отметить выполненной') : t('Перенести срок задачи')
  return <section className="card-s p-3 space-y-2 break-words min-w-0">
    <h3 className="text-[12px] font-semibold">{title}</h3><p className="text-[12px]">{shown.title}</p>
    {showPreview ? (
      <dl className="space-y-2 text-[11px] text-[var(--ink2)]">
        {shown.kind === 'reschedule_task' && (
          <div>
            <dt className="font-semibold">{t('Текущий срок')}</dt>
            <dd>{!shown.preview ? t('Текущий срок недоступен') : shown.preview.currentDue ? formatWeddingDate(shown.preview.currentDue) : t('Без срока')}</dd>
          </div>
        )}
        {shown.due && <div><dt className="font-semibold">{t('Новый срок')}</dt><dd>{formatWeddingDate(shown.due)}</dd></div>}
        <div>
          <dt className="font-semibold">{t('Почему предложено')}</dt>
          <dd>{t('Тиль подготовил предложение по вашему сообщению в чате.')}</dd>
        </div>
        <div>
          <dt className="font-semibold">{t('Кого затронет')}</dt>
          <dd>{t('Участников свадьбы с доступом к чек-листу.')}</dd>
          {shown.preview?.assignee && <dd>{t('Ответственный за задачу')}{shown.preview.assignee.name ? ` — ${shown.preview.assignee.name}` : ''}</dd>}
        </div>
      </dl>
    ) : shown.due && <p className="text-[11px] text-[var(--soft)]">{formatWeddingDate(shown.due)}</p>}
    {shown.state === 'pending' && (expired ? <p className="text-[11px] text-[var(--soft)]">{t('Предложение устарело. Попроси Тиля подготовить новое.')}</p> : shown.canApply ? <button type="button" disabled={busy} aria-busy={busy} onClick={() => void confirm()} className="press min-h-11 px-4 rounded-full grad text-[var(--on-grad)] text-[12px] disabled:opacity-50">{busy ? t('Сохраняем…') : t('Подтвердить изменение')}</button> : <p className="text-[11px] text-[var(--soft)]">{t('Подтвердить может автор запроса.')}</p>)}
    {shown.state === 'applied' && <p role="status" className="text-[12px] text-[var(--sage-deep)]">{t('Изменение выполнено')}</p>}
    {(shown.state === 'stale' || shown.state === 'dismissed') && <p className="text-[11px] text-[var(--soft)]">{t('Предложение больше не действует')}</p>}
    {error && <p role="alert" className="text-[11px] text-[var(--rose-ink)]">{error}</p>}
  </section>
}
