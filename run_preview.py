"""Open the included artwork locally; no scientific dependencies are required."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import webbrowser


def main():
    folder = Path(__file__).resolve().parent / 'dist'
    if not (folder / 'index.html').is_file():
        raise SystemExit('dist 폴더가 없습니다. 압축 파일 전체를 먼저 풀어 주세요.')
    handler = partial(SimpleHTTPRequestHandler, directory=str(folder))
    with ThreadingHTTPServer(('127.0.0.1', 0), handler) as server:
        url = f'http://127.0.0.1:{server.server_port}/'
        print(f'밤의 지문: {url}\n감상 중에는 이 창을 열어 두세요. 종료: Ctrl+C', flush=True)
        webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print('\n작품 미리보기를 종료했습니다.')


if __name__ == '__main__':
    main()
