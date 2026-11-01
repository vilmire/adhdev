/**
 * Fixed retrieval corpus for the archive search recall test (memory design
 * 2026-11-01 §3.4 acceptance): 40 stored entries (20 English, 20 Korean) and one
 * natural query per entry, written as a person would ask rather than copying
 * the entry's wording. Korean queries drop or change particles on purpose
 * (`unicode61` does no morphology).
 */
export interface CorpusItem { text: string; query: string }

export const MEMORY_SEARCH_CORPUS: readonly CorpusItem[] = [
    // ── English ──
    { text: 'On the blog project the user wants pull requests under 300 changed lines.', query: 'how big can a pull request be for the blog' },
    { text: 'Release trains for the mobile app ship on Tuesday mornings Seoul time.', query: 'when do mobile releases ship' },
    { text: 'The staging database is reset every Sunday night, never store fixtures there.', query: 'staging database reset schedule' },
    { text: 'Windows nodes need the long path registry flag before the first checkout.', query: 'windows long path checkout problem' },
    { text: 'The user dislikes emoji in commit messages and in status summaries.', query: 'emoji in summaries' },
    { text: 'Quarterly invoices go to the finance mailbox, never to the personal address.', query: 'where do invoices get sent' },
    { text: 'For the payments service, migrations must be reviewed by the DBA before merge.', query: 'payments migration review requirement' },
    { text: 'The staging cluster uses the older node 18 runtime; do not upgrade it without asking.', query: 'which node version does staging run' },
    { text: 'Backups of the photo archive run through the nightly rclone job on the NAS.', query: 'photo backup job' },
    { text: 'When the build is red on main, stop feature work and fix it first.', query: 'what to do when main is broken' },
    { text: 'The marketing site deploys through Cloudflare Pages from the www branch.', query: 'marketing website deployment branch' },
    { text: 'Customer data exports are anonymized with the scrub script before sharing.', query: 'sharing customer exports anonymize' },
    { text: 'The user prefers short stand-up style reports with blockers listed first.', query: 'report format blockers' },
    { text: 'Hotfix branches are named hotfix slash ticket number and merge without squashing.', query: 'hotfix branch naming' },
    { text: 'The analytics dashboard refreshes hourly, not in real time; avoid promising live numbers.', query: 'is the analytics dashboard live' },
    { text: 'Secrets live in the vault namespace per environment, never in dotenv files.', query: 'where are secrets stored' },
    { text: 'The legacy cluster in Frankfurt is read only until the migration finishes.', query: 'frankfurt cluster writes' },
    { text: 'Code review requests go to the platform team channel before pinging individuals.', query: 'who reviews code requests' },
    { text: 'Docker images for the worker are built on arm machines and pushed with a date tag.', query: 'worker docker image tagging' },
    { text: 'The user wants a heads up before any change that touches billing code.', query: 'billing code changes warning' },
    // ── Korean ──
    { text: '이 프로젝트에서 사용자는 풀 리퀘스트를 작게 쪼개서 올리길 원한다.', query: '풀 리퀘스트 크기' },
    { text: '모바일 앱 배포는 매주 화요일 오전에만 진행한다.', query: '앱 배포 요일' },
    { text: '스테이징 데이터베이스는 일요일 밤마다 초기화되므로 테스트 데이터를 두지 않는다.', query: '스테이징 데이터베이스 초기화' },
    { text: '윈도우 노드는 첫 체크아웃 전에 긴 경로 설정을 켜야 한다.', query: '윈도우 긴 경로 설정' },
    { text: '커밋 메시지에는 이모지를 쓰지 않는다고 사용자가 말했다.', query: '커밋 메시지 이모지' },
    { text: '분기별 청구서는 재무팀 공용 메일함으로만 보낸다.', query: '청구서는 어디로 보내나' },
    { text: '결제 서비스의 마이그레이션은 병합 전에 디비에이 검토가 필요하다.', query: '결제 마이그레이션 검토' },
    { text: '스테이징 클러스터는 구버전 노드 런타임을 쓰니 묻지 않고 올리지 않는다.', query: '스테이징 노드 버전' },
    { text: '사진 보관함 백업은 NAS의 야간 동기화 작업이 담당한다.', query: '사진 백업 작업' },
    { text: '메인 브랜치 빌드가 깨지면 기능 작업을 멈추고 먼저 고친다.', query: '메인 빌드 깨졌을 때' },
    { text: '마케팅 사이트는 www 브랜치에서 클라우드플레어 페이지로 배포된다.', query: '마케팅 사이트 배포' },
    { text: '고객 데이터 내보내기는 공유 전에 익명화 스크립트를 반드시 돌린다.', query: '고객 데이터 익명화' },
    { text: '사용자는 막힌 항목을 먼저 적은 짧은 보고를 선호한다.', query: '보고 형식 선호' },
    { text: '핫픽스 브랜치는 이슈 번호를 붙여 만들고 스쿼시 없이 병합한다.', query: '핫픽스 브랜치 이름' },
    { text: '분석 대시보드는 한 시간마다 갱신되며 실시간이 아니라고 안내해야 한다.', query: '대시보드 실시간 여부' },
    { text: '비밀 값은 환경별 볼트 네임스페이스에 두고 dotenv 파일에는 두지 않는다.', query: '비밀 값 저장 위치' },
    { text: '프랑크푸르트의 레거시 클러스터는 이전이 끝날 때까지 읽기 전용이다.', query: '프랑크푸르트 클러스터 쓰기' },
    { text: '코드 리뷰 요청은 개인에게 멘션하기 전에 플랫폼 팀 채널로 올린다.', query: '리뷰 요청 채널' },
    { text: '워커 도커 이미지는 암 머신에서 빌드해 날짜 태그로 올린다.', query: '도커 이미지 태그' },
    { text: '결제 관련 코드를 건드리는 변경은 미리 알려 달라고 했다.', query: '결제 코드 변경 사전 고지' },
];
