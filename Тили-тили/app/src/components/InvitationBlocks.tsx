import { t } from '@/lib/i18n'
import { parseInvitationDesign, type InvitationDesign } from '@/lib/invitationDesign'

/** The editor preview and guest page share exactly these finite, React-escaped blocks. */
export function InvitationBlocks({ design }: { design: InvitationDesign | unknown }) {
  let checked: InvitationDesign
  try { checked = parseInvitationDesign(design) } catch { return <p role="alert">{t('Приглашение не загрузилось. Попросите пару проверить оформление.')}</p> }
  return <div className="space-y-6 invitation-blocks">{checked.content.map(block => <InvitationBlock key={block.props.id} block={block} />)}</div>
}
export function InvitationBlock({ block }: { block: InvitationDesign['content'][number] }) {
  const card = 'card-s p-5 text-[var(--ink)]'
  switch (block.type) {
    case 'Text': return <section className={card}><h2 className="font-serif-d text-2xl break-words">{block.props.heading}</h2><p className="mt-3 whitespace-pre-wrap break-words">{block.props.body}</p></section>
    case 'Photo': return <figure className={card}>{block.props.image && <img src={block.props.image} alt={block.props.caption} className="w-full h-auto rounded-xl" loading="lazy" />}<figcaption className="mt-2 break-words">{block.props.caption}</figcaption></figure>
    case 'Program': return <section className={card}><h2 className="font-semibold">{t('Программа свадьбы')}</h2><ol className="mt-3 space-y-3">{block.props.items.map((item, i) => <li key={i} className="flex gap-4"><time className="tabular shrink-0">{item.time}</time><span className="whitespace-pre-wrap break-words min-w-0">{item.label}</span></li>)}</ol></section>
    case 'Place': return <section className={card}><h2 className="font-semibold break-words">{block.props.name}</h2><p className="mt-2 whitespace-pre-wrap break-words">{block.props.address}</p>{block.props.address && <a className="mt-3 inline-flex min-h-11 items-center underline" href={`https://yandex.ru/maps/?text=${encodeURIComponent(block.props.address)}`} target="_blank" rel="noreferrer noopener">{t('Открыть на карте')}</a>}</section>
  }
}
