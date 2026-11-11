"use client";

import {
  Bell,
  Calendar,
  Check,
  CircleHelp,
  CloudOff,
  EllipsisVertical,
  FilePlus,
  FolderPlus,
  GripVertical,
  ImageUp,
  KeyRound,
  ListChecks,
  Loader2,
  type LucideIcon,
  Megaphone,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Share,
  Trash2,
  TriangleAlert,
  Zap,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { SHOW_WELCOME } from "@/components/onboarding/welcome-tour";
import { MobileHeader } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { useClientValue } from "@/lib/hooks/use-client-value";
import { t } from "@/lib/i18n/ja";

/** The key held for shortcuts here: ⌘ on a Mac (and an iPad's keyboard), Ctrl elsewhere. */
const modOf = () => (/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘" : "Ctrl＋");

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="bg-muted rounded border px-1.5 py-0.5 font-mono text-[0.8em] whitespace-nowrap">{children}</kbd>
  );
}

/** A button's icon in the text, as it is drawn on the screen, so it can be found there. */
function Ico({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="bg-muted mx-0.5 inline-flex size-6 items-center justify-center rounded align-middle">
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-16 space-y-3">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="text-foreground/90 space-y-3 text-sm leading-relaxed">{children}</div>
    </section>
  );
}

/** A small label for what only one kind of device does. */
function For({ children }: { children: ReactNode }) {
  return (
    <span className="bg-muted text-muted-foreground mr-1.5 rounded px-1.5 py-0.5 text-xs whitespace-nowrap">
      {children}
    </span>
  );
}

const SECTIONS = [
  { id: "start", title: "はじめに" },
  { id: "write", title: "メモを書く" },
  { id: "notation", title: "かんたんな書き方" },
  { id: "quick", title: "即席メモと Todo" },
  { id: "folders", title: "フォルダで整理する" },
  { id: "images", title: "画像やファイル" },
  { id: "search", title: "メモを探す" },
  { id: "trash", title: "消したメモを戻す" },
  { id: "devices", title: "どの端末でも使う" },
  { id: "phone", title: "スマホで使う" },
  { id: "desktop", title: "デスクトップ版" },
  { id: "more", title: "もっと便利に" },
  { id: "trouble", title: "困ったとき" },
] as const;

const title = (id: (typeof SECTIONS)[number]["id"]) => SECTIONS.find((each) => each.id === id)!.title;

/** Lines typed at the start of a line, and what they make. */
const NOTATIONS: { typed: string; how: string; makes: string }[] = [
  { typed: "# ", how: "シャープと空白", makes: "見出し（「## 」「### 」で小さな見出し）" },
  { typed: "- ", how: "ハイフンと空白", makes: "箇条書き" },
  { typed: "1. ", how: "数字、ピリオド、空白", makes: "番号付きの行" },
  { typed: "[] ", how: "かっこと空白", makes: "チェック項目（□ を押すとチェック）" },
  { typed: "> ", how: "記号と空白", makes: "引用" },
  { typed: "``` ", how: "バッククォート 3 つと空白", makes: "コード" },
  { typed: "---", how: "ハイフン 3 つ", makes: "区切り線" },
];

/** The sync badge's words (top of the sidebar), and what each means. */
const BADGE: { icon: LucideIcon; said: string; means: string }[] = [
  { icon: Check, said: t.sync.idle, means: "すべて送り終わっています。" },
  { icon: Loader2, said: "未送信 ○ 件", means: "これから送る編集があります。しばらく待つと送られます。" },
  { icon: CloudOff, said: t.sync.offline, means: "電波がありません。書いた内容は端末に残り、つながったら送られます。" },
  {
    icon: KeyRound,
    said: t.sync.signInWait,
    means: "ログインを確かめ直しています。編集は端末に残っていて、戻りしだい送ります。",
  },
  { icon: ImageUp, said: t.sync.uploadsWaiting, means: "通信が遅く、画像をまだ送れていません。自動で送り直します。" },
  {
    icon: TriangleAlert,
    said: t.sync.stuck,
    means: "サーバーが受け取れない編集があります。表示を押すと、もう一度送れます。",
  },
];

/**
 * How Memoca is used, for someone new to it: what is used most, first, in
 * plain words, with what differs on a phone and in the desktop app said
 * where it does, and each button drawn as it is on the screen. Opened from
 * the sidebar's ？, the settings and the welcome.
 */
export default function HelpPage() {
  const mod = useClientValue(modOf, "⌘");
  return (
    <div className="flex flex-1 flex-col">
      <MobileHeader title={t.nav.help} />
      <div className="mx-auto w-full max-w-2xl space-y-10 px-4 py-6 sm:px-6">
        <div className="space-y-3">
          <h1 className="text-lg font-semibold tracking-tight">{t.nav.help}</h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Memoca の基本的な使い方です。気になるところから読んでください。
          </p>
          <nav aria-label="目次" className="bg-muted/40 rounded-lg border p-3">
            <ol className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {SECTIONS.map((section, index) => (
                <li key={section.id}>
                  <a href={`#${section.id}`} className="hover:underline">
                    {index + 1}. {section.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </div>

        <Section id="start" title={title("start")}>
          <p>Memoca は、思いついたことをすぐ書いて、あとでゆっくり整理できるメモアプリです。</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>書いたメモは、自動で保存されます。保存ボタンを押す必要はありません。</li>
            <li>同じアカウントでログインすると、スマホでもパソコンでも同じメモが見られます。</li>
            <li>電波がないときも書けます。つながったら、自動で送られます。</li>
          </ul>
          <p>
            画面の左が「サイドバー」で、フォルダとメモが並んでいます（スマホでは、左上の <Ico icon={Menu} /> で開きます）。メモを押すと、右に開きます。
          </p>
          <Button variant="outline" size="sm" onClick={() => window.dispatchEvent(new Event(SHOW_WELCOME))}>
            はじめの案内をもう一度見る
          </Button>
        </Section>

        <Section id="write" title={title("write")}>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              サイドバーの「フォルダ」の横の <Ico icon={FilePlus} />（メモを追加）を押します。
              フォルダの中に作るときは、フォルダの右の <Ico icon={MoreHorizontal} /> から<strong>「新しいメモ」</strong>を選びます。
            </li>
            <li>いちばん上の行にタイトルを、その下に本文を書きます。</li>
            <li>書いた内容はすぐに保存されます。ほかのメモに移っても、そのまま残ります。</li>
          </ol>
          <p>
            メモの右上の <Ico icon={MoreHorizontal} />（メモの操作）から、ピン留め・移動・削除などができます。消したメモは、しばらくゴミ箱に残ります。
          </p>
        </Section>

        <Section id="notation" title={title("notation")}>
          <p>行のはじめに次の記号を打つと、その行が変わります。</p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-1.5 pr-4 font-medium">打つもの</th>
                  <th className="py-1.5 font-medium">なるもの</th>
                </tr>
              </thead>
              <tbody>
                {NOTATIONS.map((row) => (
                  <tr key={row.typed} className="border-b last:border-b-0">
                    <td className="py-1.5 pr-4">
                      <Kbd>{row.typed.trimEnd()}</Kbd>
                      <span className="text-muted-foreground ml-1.5 text-xs whitespace-nowrap">（{row.how}）</span>
                    </td>
                    <td className="py-1.5">{row.makes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <Kbd>/</Kbd>（スラッシュ）を打つとメニューが出て、見出し・表・画像などを選べます。
            </li>
            <li>
              <strong>日本語入力がオンのまま</strong>でも使えます。たとえば「ー」のあとに空白で箇条書き、「１．」のあとに空白で番号付きの行になります。
            </li>
            <li>
              箇条書きの中で <Kbd>Tab</Kbd> を押すと 1 段下げ、<Kbd>Shift</Kbd>＋<Kbd>Tab</Kbd> で戻せます。
            </li>
            <li>
              文字を選んで <Kbd>{mod}B</Kbd> で太字、<Kbd>{mod}I</Kbd> で斜体にできます。
            </li>
            <li>
              <Kbd>[[</Kbd> と打つと、ほかのメモへのリンクを入れられます。
            </li>
            <li>
              行の左の <Ico icon={GripVertical} /> をドラッグすると、行を上下に動かせます。押すと、複製・コピー・削除のメニューが出ます。
            </li>
            <li>
              間違えたら <Kbd>{mod}Z</Kbd> で元に戻せます。
            </li>
          </ul>
        </Section>

        <Section id="quick" title={title("quick")}>
          <p>
            <strong>即席メモ</strong>は、思いついたことをすぐ書くための場所です。書いてから保存すると、ふつうのメモになります。
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <For>パソコン</For>サイドバーの <Ico icon={Zap} />「即席メモ」を押します。
            </li>
            <li>
              <For>スマホ</For>画面の下の <Ico icon={Zap} />「即席メモ」を押します。
            </li>
            <li>
              <For>デスクトップ版</For>どのアプリを使っていても、ホットキー（はじめは <Kbd>⌘⇧M</Kbd>、Windows は{" "}
              <Kbd>Ctrl＋Shift＋M</Kbd>）で出せます。
            </li>
          </ul>
          <ol className="list-decimal space-y-1 pl-5">
            <li>思いついたことを書きます。書きかけでも、閉じれば下書きとして残ります。</li>
            <li>
              <strong>「保存」</strong>（または <Kbd>{mod}Enter</Kbd>）で、選んだフォルダ（はじめは Inbox）にメモとして保存します。
            </li>
            <li>
              上のタブの <Ico icon={Plus} /> で、書きかけをいくつも並べておけます。
            </li>
          </ol>
          <p>
            <strong>Todo</strong> は、やることを並べるチェックリストです。即席メモのタブの並びの右にある <Ico icon={ListChecks} />（Todo を開く）で開きます。
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              項目の右の <Ico icon={Calendar} /> で期日を付けると、期日の近い順に並びます。
            </li>
            <li>
              右上の <Ico icon={Bell} />（期日の通知）から、期日が近づいたときの通知を受け取れます。
            </li>
          </ul>
        </Section>

        <Section id="folders" title={title("folders")}>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>フォルダを作る</strong>：サイドバーの「フォルダ」の横の <Ico icon={FolderPlus} />（フォルダを追加）を押します。
            </li>
            <li>
              <strong>名前を変える</strong>：フォルダの右の <Ico icon={MoreHorizontal} /> から「名前を変更」を選びます。
            </li>
            <li>
              <strong>メモを移す</strong>：メモをドラッグして、移したいフォルダの上で離します。メモの <Ico icon={MoreHorizontal} /> の「移動」からも移せます。
            </li>
            <li>
              <strong>フォルダの中にフォルダ</strong>：フォルダの <Ico icon={MoreHorizontal} /> から「サブフォルダを追加」を選びます。フォルダごと移すときは「別のフォルダへ移動」です。
            </li>
            <li>
              <strong>よく使うメモ</strong>は、メモの <Ico icon={MoreHorizontal} /> から「ピン留め」すると、サイドバーの「ピン留め」にまとまります。
            </li>
          </ul>
        </Section>

        <Section id="images" title={title("images")}>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              画像は、メモに<strong>貼り付ける</strong>か、<strong>ドラッグ</strong>して入れます。<Kbd>/</Kbd> のメニューの「画像」からも選べます。
            </li>
            <li>写真は自動で小さくしてから送るので、容量を使いすぎません。</li>
            <li>PDF やほかのファイルも、同じようにメモに入れられます。</li>
            <li>URL を貼ると、そのままリンクになります。</li>
          </ul>
        </Section>

        <Section id="search" title={title("search")}>
          <p>
            サイドバーの下の <Ico icon={Search} />（検索）、または <Kbd>{mod}K</Kbd> で、すべてのメモから探せます。タイトルだけでなく本文も探し、ひらがなとカタカナの違いも気にせず見つけます。
          </p>
          <p>
            開いているメモの中を探すときは <Kbd>{mod}F</Kbd> です。<Kbd>Enter</Kbd> で次の場所へ移ります。
          </p>
        </Section>

        <Section id="trash" title={title("trash")}>
          <p>
            消したメモやフォルダは、サイドバーの下の <Ico icon={Trash2} />（ゴミ箱）にしばらく残ります（はじめは 30 日。設定で変えられます）。ゴミ箱で「復元」を押すと、元の場所に戻ります。
          </p>
          <p>
            メモの中身を前の状態に戻したいときは、メモの <Ico icon={MoreHorizontal} /> の<strong>「変更履歴」</strong>から選べます。
          </p>
        </Section>

        <Section id="devices" title={title("devices")}>
          <p>
            同じアカウントでログインすれば、どの端末でも同じメモが見られます。書いた内容は、すぐにほかの端末にも届きます。
          </p>
          <p>
            同期の表示（パソコンはサイドバーのいちばん上、スマホは画面の右上）で、送れているかが分かります。
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <tbody>
                {BADGE.map((row) => (
                  <tr key={row.said} className="border-b last:border-b-0">
                    <td className="py-1.5 pr-4 font-medium whitespace-nowrap">
                      <row.icon className="text-muted-foreground mr-1.5 inline size-3.5 align-[-2px]" aria-hidden />
                      {row.said}
                    </td>
                    <td className="py-1.5">{row.means}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section id="phone" title={title("phone")}>
          <p>スマホでは、ホーム画面に追加すると、アプリのように開けて、電波がないときも使えます。</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <For>iPhone・iPad</For>Safari で開き、<Ico icon={Share} />（共有）から「ホーム画面に追加」を選びます。追加したあと、一度だけログインし直してください。
            </li>
            <li>
              <For>Android</For>Chrome の <Ico icon={EllipsisVertical} />（メニュー）から「アプリをインストール」を選びます。ほかのアプリの共有メニューから、Memoca に直接送れるようになります。
            </li>
          </ul>
          <p>Todo の期日の通知は、ホーム画面に追加した Memoca で受け取れます（iPhone は iOS 16.4 以降）。</p>
        </Section>

        <Section id="desktop" title={title("desktop")}>
          <p>
            Mac と Windows では、デスクトップ版も使えます。メニューバー（Windows はタスクバーの右下）に <Ico icon={Zap} /> が常にいて、どのアプリを使っていても、ホットキーで即席メモを出せます。
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <Ico icon={Zap} /> のメニューの「Memoca を開く」で、メモの一覧や編集もできる大きいウィンドウが開きます。
            </li>
            <li>ホットキーは、設定の「デスクトップ版のホットキー」で変えられます。</li>
            <li>Todo の期日の通知を、パソコンの通知として受け取れます。</li>
          </ul>
        </Section>

        <Section id="more" title={title("more")}>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>ロック（金庫）</strong>：大事なメモやフォルダは、<Ico icon={MoreHorizontal} /> の「ロックする」で暗号化できます。開くには金庫のパスワードが要ります。
            </li>
            <li>
              <strong>テンプレート</strong>：よく使う形のメモは、メモの <Ico icon={MoreHorizontal} /> の「テンプレートとして保存」でテンプレートにしておくと、フォルダの <Ico icon={MoreHorizontal} /> の「テンプレートから作成」で同じ形から作れます。
            </li>
            <li>
              <strong>書き出し</strong>：設定の「書き出し」で、すべてのメモをまとめて保存できます。1 つのメモは、<Ico icon={MoreHorizontal} /> の「PDF で書き出す」で PDF にできます。
            </li>
            <li>
              <strong>見た目</strong>：設定の「外観」で、ダークモードにできます。
            </li>
          </ul>
        </Section>

        <Section id="trouble" title={title("trouble")}>
          <dl className="space-y-3">
            <div>
              <dt className="font-medium">ほかの端末に、書いた内容が出ない</dt>
              <dd className="text-foreground/80">
                まず、書いた端末の同期の表示を見てください（上の「どの端末でも使う」）。「同期済み」になっていれば、出ない端末でページを開き直してください。
              </dd>
            </div>
            <div>
              <dt className="font-medium">メモを消してしまった</dt>
              <dd className="text-foreground/80">ゴミ箱から「復元」で戻せます。</dd>
            </div>
            <div>
              <dt className="font-medium">前の内容に戻したい</dt>
              <dd className="text-foreground/80">
                メモの <Ico icon={MoreHorizontal} /> の「変更履歴」から、戻したい時点を選べます。
              </dd>
            </div>
            <div>
              <dt className="font-medium">新しくなったことを知りたい</dt>
              <dd className="text-foreground/80">
                サイドバーの下の <Ico icon={Megaphone} />（
                <Link href="/app/news" className="underline">
                  お知らせ
                </Link>
                ）にまとめています。この使い方は、<Ico icon={CircleHelp} /> からいつでも開けます。
              </dd>
            </div>
          </dl>
        </Section>
      </div>
    </div>
  );
}
