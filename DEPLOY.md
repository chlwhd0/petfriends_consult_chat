# Firebase 배포 안내

화면은 Firebase Hosting, 챗봇의 Claude 호출은 Cloud Functions(`functions/index.js`)가 맡습니다.
API 키는 코드나 저장소에 두지 않고 Secret Manager에 보관합니다.

```
브라우저 → Firebase Hosting (public/index.html)
        → /api/chat  →  Cloud Functions "chat" (서울)  →  Claude API
                              └ 시크릿 ANTHROPIC_API_KEY
```

## 필요한 것
- Google 계정, Firebase 프로젝트 (결제를 켜는 Blaze 요금제 필요: Cloud Functions와 Secret Manager 때문)
- Claude API 키 (console.anthropic.com)
- Node.js 20.6 이상

아래 명령은 모두 이 폴더에서 실행합니다. Firebase CLI는 설치 없이 `npx`로 씁니다.

## 1. 로그인
```bash
npx -y firebase-tools@15 login
```

## 2. 프로젝트 준비
프로젝트 ID는 전 세계에서 유일해야 합니다. 이미 있는 프로젝트를 쓰면 이 단계는 건너뜁니다.
```bash
npx -y firebase-tools@15 projects:create 내-프로젝트-id
```
그다음 Firebase 콘솔에서 **Blaze 요금제로 업그레이드**합니다(결제 카드 등록).
콘솔 → 프로젝트 → 왼쪽 아래 요금제 → 업그레이드. 이 단계는 콘솔에서만 할 수 있습니다.

## 3. 프로젝트 연결
```bash
npx -y firebase-tools@15 use 내-프로젝트-id
```

## 4. API 키를 시크릿으로 저장
실행하면 값을 물어봅니다. 그 자리에서 키를 붙여 넣으세요. 화면에 표시되지 않습니다.
```bash
npx -y firebase-tools@15 functions:secrets:set ANTHROPIC_API_KEY
```

## 5. 배포
```bash
npx -y firebase-tools@15 deploy --only functions,hosting
```
처음에는 필요한 Google 서비스를 켜느라 몇 분 걸립니다. 끝나면 `https://내-프로젝트-id.web.app` 주소가 나옵니다.

## 비용 보호 (공개 사이트라 중요합니다)
함수에 이미 들어 있는 장치:
- 같은 접속자(IP)당 분당 10회, 하루 120회 호출 제한
- 요청 크기 제한(메시지 40개, 6만 자), 답변 길이 제한(2,048토큰)
- 함수 서버 최대 3대(`maxInstances`)
- 한도 초과 시 화면에 안내 문구 표시

다만 이 호출 제한은 서버 한 대 안에서 세는 간이 방식이라 완전하지 않습니다. 추가로 꼭 설정하세요.
- Anthropic 콘솔(Billing)에서 월 사용 한도
- Google Cloud 콘솔 → 결제 → 예산 및 알림

## 알아 둘 점
- 관리자 화면 비밀번호(`admin`)는 화면 파일 안에 있어 누구나 볼 수 있습니다. 실제 보안 기능이 아닙니다.
- 상품·주문·접수·대화 기록·피드백·신고는 **Firestore(서울)** 에 저장되어 모든 방문자와 관리자가 같은 데이터를 봅니다. 아래 "데이터 저장(Firestore)" 참고.
- 관리자 비밀번호가 화면 파일에 있는 구조라, 로그인한 방문자(익명 로그인)는 개발자 도구로 모든 기록을 읽고 쓸 수 있습니다(규칙은 값의 형태와 크기만 검증합니다). 개인정보가 섞일 수 있는 대화 기록을 보호하려면 관리자 로그인을 Google 로그인 등으로 바꾸고 규칙을 관리자 전용으로 좁혀야 합니다.
- 답변은 Hosting을 거치며 한 번에 도착할 수도 있습니다(글자가 흐르는 효과가 약해질 수 있음).

## 데이터 저장(Firestore) 준비
화면(`public/index.html`)은 방문자마다 Firebase **익명 로그인**을 한 뒤 Firestore에 읽고 씁니다. 연결에 실패하면 예전처럼 브라우저(localStorage)에 저장합니다.
1. **Authentication 시작과 익명 로그인 사용 설정**: Firebase 콘솔 → 빌드 → Authentication → 시작하기 → Sign-in method → 익명 → 사용 설정 (콘솔에서만 가능)
2. 데이터베이스 만들기(서울): `npx -y firebase-tools@15 firestore:databases:create "(default)" --location asia-northeast3 --project 내-프로젝트-id`
3. 규칙 배포: `npx -y firebase-tools@15 deploy --only firestore --project 내-프로젝트-id` (`firestore.rules`)
4. 화면 배포: `npx -y firebase-tools@15 deploy --only hosting --project 내-프로젝트-id`
5. 처음 접속하면 서버가 비어 있을 때 화면이 처음 데이터(SEED)를 자동으로 채웁니다.

화면 파일 안의 Firebase 웹 설정(`FBCFG`)은 공개되어도 되는 값입니다. 프로젝트를 바꾸면 이 값을 새 웹 앱의 설정으로 바꿔야 합니다(`firebase apps:sdkconfig web`).

## 문제 해결
- `Blaze` 관련 오류: 2단계의 요금제 업그레이드가 안 된 것입니다.
- 챗봇에 "API 키를 찾지 못했어요": 4단계 뒤에 다시 배포(5단계)했는지 확인하세요.
- 로컬에서 쓰려면: `node --env-file=.env server.js` (이 경우 키는 `.env`에 둡니다)
