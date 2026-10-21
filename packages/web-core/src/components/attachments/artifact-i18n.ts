import type { TFunction } from 'i18next'
import type { ArtifactKind } from '@adhdev/daemon-core'

export type ArtifactTranslationKey =
    | 'chat.artifact'
    | 'artifact.viewFull'
    | 'artifact.viewFullTitle'
    | 'artifact.collapse'
    | 'artifact.download'
    | 'artifact.downloading'
    | 'artifact.copyContent'
    | 'artifact.loading'
    | 'artifact.retry'
    | 'artifact.openLightbox'
    | 'artifact.closeLightbox'
    | 'artifact.zoomIn'
    | 'artifact.zoomOut'
    | 'artifact.zoomReset'
    | 'artifact.hashChangedWarning'
    | 'artifact.hashChangedDetail'
    | 'artifact.invalidJsonNotice'
    | 'artifact.emptyContent'
    | 'artifact.errorMissingSession'
    | 'artifact.errorFileMissing'
    | 'artifact.errorFileTooLarge'
    | 'artifact.errorUnsupported'
    | 'artifact.errorGeneric'
    | 'artifact.kind.markdown'
    | 'artifact.kind.diff'
    | 'artifact.kind.json'
    | 'artifact.kind.text'
    | 'artifact.kind.image'

export const ARTIFACT_FALLBACK_TRANSLATIONS: Readonly<
    Record<'en' | 'ko' | 'ja' | 'zh-CN' | 'es', Readonly<Record<ArtifactTranslationKey, string>>>
> = {
    en: {
        'chat.artifact': 'Artifact',
        'artifact.viewFull': 'View full',
        'artifact.viewFullTitle': 'View full (전체 보기)',
        'artifact.collapse': 'Collapse',
        'artifact.download': 'Download',
        'artifact.downloading': 'Downloading…',
        'artifact.copyContent': 'Copy',
        'artifact.loading': 'Loading artifact…',
        'artifact.retry': 'Retry',
        'artifact.openLightbox': 'Expand image',
        'artifact.closeLightbox': 'Close image preview',
        'artifact.zoomIn': 'Zoom in',
        'artifact.zoomOut': 'Zoom out',
        'artifact.zoomReset': 'Reset zoom',
        'artifact.hashChangedWarning': 'File modified since registration',
        'artifact.hashChangedDetail': 'The workspace file SHA-256 hash changed after this artifact was registered.',
        'artifact.invalidJsonNotice': 'Malformed JSON — showing raw text',
        'artifact.emptyContent': 'Empty artifact file',
        'artifact.errorMissingSession': 'Session context is required to load this artifact.',
        'artifact.errorFileMissing': 'The artifact file is no longer present in the workspace.',
        'artifact.errorFileTooLarge': 'This artifact exceeds the 4 MiB viewer limit.',
        'artifact.errorUnsupported': 'This artifact format is not supported in the viewer.',
        'artifact.errorGeneric': 'Could not load full artifact content.',
        'artifact.kind.markdown': 'Markdown',
        'artifact.kind.diff': 'Diff',
        'artifact.kind.json': 'JSON',
        'artifact.kind.text': 'Text',
        'artifact.kind.image': 'Image',
    },
    ko: {
        'chat.artifact': '산출물',
        'artifact.viewFull': '전체 보기',
        'artifact.viewFullTitle': '전체 보기',
        'artifact.collapse': '접기',
        'artifact.download': '다운로드',
        'artifact.downloading': '다운로드 중…',
        'artifact.copyContent': '복사',
        'artifact.loading': '산출물을 불러오는 중…',
        'artifact.retry': '다시 시도',
        'artifact.openLightbox': '이미지 확대',
        'artifact.closeLightbox': '이미지 미리보기 닫기',
        'artifact.zoomIn': '확대',
        'artifact.zoomOut': '축소',
        'artifact.zoomReset': '원래 크기',
        'artifact.hashChangedWarning': '등록 이후 파일이 변경됨',
        'artifact.hashChangedDetail': '이 산출물이 등록된 이후 작업 공간 파일의 SHA-256 해시가 변경되었습니다.',
        'artifact.invalidJsonNotice': '유효하지 않은 JSON — 원문 텍스트로 표시합니다',
        'artifact.emptyContent': '빈 산출물 파일입니다',
        'artifact.errorMissingSession': '이 산출물을 불러오려면 세션 정보가 필요합니다.',
        'artifact.errorFileMissing': '작업 공간에서 산출물 파일을 찾을 수 없습니다.',
        'artifact.errorFileTooLarge': '산출물 크기가 4 MiB 제한을 초과합니다.',
        'artifact.errorUnsupported': '뷰어에서 지원하지 않는 산출물 형식입니다.',
        'artifact.errorGeneric': '산출물 전체 내용을 불러오지 못했습니다.',
        'artifact.kind.markdown': '마크다운',
        'artifact.kind.diff': '변경분 (Diff)',
        'artifact.kind.json': 'JSON',
        'artifact.kind.text': '텍스트',
        'artifact.kind.image': '이미지',
    },
    ja: {
        'chat.artifact': 'アーティファクト',
        'artifact.viewFull': '全体を表示',
        'artifact.viewFullTitle': '全体を表示 (전체 보기)',
        'artifact.collapse': '折りたたむ',
        'artifact.download': 'ダウンロード',
        'artifact.downloading': 'ダウンロード中…',
        'artifact.copyContent': 'コピー',
        'artifact.loading': 'アーティファクトを読み込み中…',
        'artifact.retry': '再試行',
        'artifact.openLightbox': '画像を拡大',
        'artifact.closeLightbox': '画像プレビューを閉じる',
        'artifact.zoomIn': '拡大',
        'artifact.zoomOut': '縮小',
        'artifact.zoomReset': 'リセット',
        'artifact.hashChangedWarning': '登録後にファイルが変更されました',
        'artifact.hashChangedDetail': 'このアーティファクトの登録後にワークスペースファイルの SHA-256 ハッシュが変更されました。',
        'artifact.invalidJsonNotice': '不正な JSON — 生テキストを表示しています',
        'artifact.emptyContent': '空のアーティファクトファイル',
        'artifact.errorMissingSession': 'このアーティファクトを読み込むにはセッション情報が必要です。',
        'artifact.errorFileMissing': 'ワークスペースにアーティファクトファイルが見つかりません。',
        'artifact.errorFileTooLarge': 'アーティファクトが 4 MiB の上限を超えています。',
        'artifact.errorUnsupported': 'このアーティファクト形式はサポートされていません。',
        'artifact.errorGeneric': 'アーティファクトの全内容を読み込めませんでした。',
        'artifact.kind.markdown': 'Markdown',
        'artifact.kind.diff': 'Diff',
        'artifact.kind.json': 'JSON',
        'artifact.kind.text': 'テキスト',
        'artifact.kind.image': '画像',
    },
    'zh-CN': {
        'chat.artifact': '产物',
        'artifact.viewFull': '查看全部',
        'artifact.viewFullTitle': '查看全部 (전체 보기)',
        'artifact.collapse': '收起',
        'artifact.download': '下载',
        'artifact.downloading': '下载中…',
        'artifact.copyContent': '复制',
        'artifact.loading': '正在加载产物…',
        'artifact.retry': '重试',
        'artifact.openLightbox': '放大图片',
        'artifact.closeLightbox': '关闭图片预览',
        'artifact.zoomIn': '放大',
        'artifact.zoomOut': '缩小',
        'artifact.zoomReset': '重置缩放',
        'artifact.hashChangedWarning': '文件在注册后已更改',
        'artifact.hashChangedDetail': '此产物注册后，工作区文件的 SHA-256 哈希值已发生更改。',
        'artifact.invalidJsonNotice': 'JSON 格式无效 — 显示原始文本',
        'artifact.emptyContent': '空产物文件',
        'artifact.errorMissingSession': '加载此产物需要会话上下文。',
        'artifact.errorFileMissing': '工作区中已不存在该产物文件。',
        'artifact.errorFileTooLarge': '此产物超过 4 MiB 查看器限制。',
        'artifact.errorUnsupported': '查看器不支持此产物格式。',
        'artifact.errorGeneric': '无法加载完整产物内容。',
        'artifact.kind.markdown': 'Markdown',
        'artifact.kind.diff': 'Diff',
        'artifact.kind.json': 'JSON',
        'artifact.kind.text': '文本',
        'artifact.kind.image': '图片',
    },
    es: {
        'chat.artifact': 'Artefacto',
        'artifact.viewFull': 'Ver completo',
        'artifact.viewFullTitle': 'Ver completo (전체 보기)',
        'artifact.collapse': 'Contraer',
        'artifact.download': 'Descargar',
        'artifact.downloading': 'Descargando…',
        'artifact.copyContent': 'Copiar',
        'artifact.loading': 'Cargando artefacto…',
        'artifact.retry': 'Reintentar',
        'artifact.openLightbox': 'Ampliar imagen',
        'artifact.closeLightbox': 'Cerrar vista previa',
        'artifact.zoomIn': 'Acercar',
        'artifact.zoomOut': 'Alejar',
        'artifact.zoomReset': 'Restablecer zoom',
        'artifact.hashChangedWarning': 'Archivo modificado tras el registro',
        'artifact.hashChangedDetail': 'El hash SHA-256 del archivo en el espacio de trabajo cambió después de registrar este artefacto.',
        'artifact.invalidJsonNotice': 'JSON no válido — mostrando texto sin formato',
        'artifact.emptyContent': 'Archivo de artefacto vacío',
        'artifact.errorMissingSession': 'Se requiere el contexto de la sesión para cargar este artefacto.',
        'artifact.errorFileMissing': 'El archivo del artefacto ya no se encuentra en el espacio de trabajo.',
        'artifact.errorFileTooLarge': 'Este artefacto supera el límite de 4 MiB del visor.',
        'artifact.errorUnsupported': 'Este formato de artefacto no es compatible con el visor.',
        'artifact.errorGeneric': 'No se pudo cargar el contenido completo del artefacto.',
        'artifact.kind.markdown': 'Markdown',
        'artifact.kind.diff': 'Diff',
        'artifact.kind.json': 'JSON',
        'artifact.kind.text': 'Texto',
        'artifact.kind.image': 'Imagen',
    },
}

function resolveLangBucket(language?: string | null): 'en' | 'ko' | 'ja' | 'zh-CN' | 'es' {
    const raw = typeof language === 'string' ? language.trim() : ''
    if (raw.startsWith('ko')) return 'ko'
    if (raw.startsWith('ja')) return 'ja'
    if (raw.startsWith('zh')) return 'zh-CN'
    if (raw.startsWith('es')) return 'es'
    return 'en'
}

export function trArtifact(
    t: TFunction,
    language: string | undefined,
    key: ArtifactTranslationKey,
): string {
    const bucket = resolveLangBucket(language)
    const fallback = ARTIFACT_FALLBACK_TRANSLATIONS[bucket][key] ?? ARTIFACT_FALLBACK_TRANSLATIONS.en[key]
    return String(t(key, { defaultValue: fallback }))
}

export function getArtifactKindLabel(
    t: TFunction,
    language: string | undefined,
    kind: ArtifactKind,
): string {
    const key = `artifact.kind.${kind}` as ArtifactTranslationKey
    if (key in ARTIFACT_FALLBACK_TRANSLATIONS.en) {
        return trArtifact(t, language, key)
    }
    return trArtifact(t, language, 'artifact.kind.text')
}

export function getArtifactErrorCopy(
    t: TFunction,
    language: string | undefined,
    errorCode: string | null | undefined,
    rawError: string | null | undefined,
): string {
    if (errorCode === 'missing_session_context') {
        return trArtifact(t, language, 'artifact.errorMissingSession')
    }
    if (errorCode === 'file_missing' || errorCode === 'artifact_not_found' || errorCode === 'not_a_regular_file') {
        return trArtifact(t, language, 'artifact.errorFileMissing')
    }
    if (errorCode === 'file_too_large' || errorCode === 'artifact_too_large') {
        return trArtifact(t, language, 'artifact.errorFileTooLarge')
    }
    if (errorCode === 'unsupported_kind' || errorCode === 'unsupported_mime' || errorCode === 'unsupported_mime_or_kind') {
        return trArtifact(t, language, 'artifact.errorUnsupported')
    }
    if (typeof rawError === 'string' && rawError.trim()) {
        return rawError.trim()
    }
    return trArtifact(t, language, 'artifact.errorGeneric')
}
