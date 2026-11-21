"""Download official, revision-pinned XTTS weights only after interactive agreement."""
from clone_voice import MODEL, FILES

if __name__ == '__main__':
    print('XTTS-v2: условия использования модели и результата — https://huggingface.co/coqui/XTTS-v2/blob/main/LICENSE.txt')
    if input('Прочитали и принимаете условия для своего использования? Введите ДА: ').strip() != 'ДА':
        raise SystemExit('Загрузка отменена.')
    from huggingface_hub import snapshot_download
    snapshot_download(repo_id='coqui/XTTS-v2', revision='6c2b0d75eae4b7047358e3b6bd9325f857d43f77', local_dir=str(MODEL), allow_patterns=[*FILES, 'LICENSE.txt'])
    print('Готово. Запустите python server.py из этого же окружения.')
