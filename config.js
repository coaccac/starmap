/* 앱 기본 설정. 두 폰이 같은 사이트를 쓰니, 여기 적어 두면 두 폰 모두 켜자마자 적용돼요.
   - kakaoKey: 카카오 JavaScript 키. 공개용 클라이언트 키라 여기 둬도 되지만, 카카오 개발자 콘솔의
     "JavaScript SDK 도메인"에 등록된 주소에서만 동작해요.
   - syncUrl: 구글 시트 동기화 주소 (Apps Script 웹 앱 URL, …/exec). 비워 두면 각 폰 설정에서 넣어요.
     이 주소를 아는 사람은 시트에 점수를 쓸 수 있으니, 걱정되면 Code.gs 의 TOKEN 을 정하고 폰 설정에 넣어요. */
window.STARMAP_CONFIG = {
  kakaoKey: 'f57a6fd1e56a7ab3696cef10aa4ee79a',
  syncUrl: 'https://script.google.com/macros/s/AKfycbzvYkmqX33Ds9vGCjHazH6UfjKQiRFiJ8Xv4byW0WiEXHWUeLpjZoZ3lnRQSljI7ake/exec',
};
