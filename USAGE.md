# Использование Grafana Dashboard Sync

Этот документ описывает практическую работу с расширением `Grafana Dashboard Sync` в VS Code.

## Что Делает Плагин

Плагин помогает:

- хранить Grafana dashboards в git
- делать `pull` из dev Grafana
- управлять ревизиями дашбордов
- задавать target-specific overrides
- настраивать datasource mappings
- выполнять `render` для конкретных targets
- делать `deploy` и `backup`
- выгружать alerts (rules + contact points) по target

Основная идея:

- локальный проект хранит source dashboards и историю ревизий
- `pull` разрешен только из `dev target`
- `render` и `deploy` выполняются уже в контексте выбранного target

## Основные Понятия

- `Instance`:
  логическое подключение к Grafana organization или серверу
- `Target`:
  конкретная среда внутри instance, например `dev`, `test`, `prod`
- `Dev Target`:
  единственный target, из которого разрешен `pull`
- `Active Target`:
  target, относительно которого работают многие команды из дерева `Dashboards`
- `Revision`:
  сохраненный snapshot дашборда
- `Working Copy`:
  локально checkout-нутая ревизия файла в проекте

## Структура Проекта

Поддерживается только текущий layout:

```text
project-root/
  .grafana-dashboard-workspace.json
  dashboards/
  backups/
  renders/
  alerts/   # появится после первого Pull Alerts
```

Важно:

- отдельная filesystem-based папка `instances/` больше не используется
- instances, targets, dashboards и datasource mappings хранятся в `.grafana-dashboard-workspace.json`
- `GRAFANA_URL` и `GRAFANA_USERNAME` сохраняются в config файла проекта
- token и password хранятся в VS Code Secret Storage

## Быстрый Старт

1. Открой папку проекта в VS Code.
2. Выполни `Grafana Sync: Initialize Grafana Dashboard Project`.
3. В дереве `Instances` создай instance:
   - `Grafana Sync: Create Instance`
4. Для instance задай `GRAFANA_URL` в `Details > Instance`.
5. Настрой аутентификацию instance:
   - либо `Grafana Sync: Set Instance Token`
   - либо укажи `GRAFANA_USERNAME` и сохрани пароль командой `Grafana Sync: Set Instance Password`
6. Создай deployment target:
   - `Grafana Sync: Create Deployment Target`
7. Выбери dev target:
   - `Grafana Sync: Select Dev Target`
8. Добавь дашборд в проект:
   - `Grafana Sync: Add Dashboard`
9. Выполни `pull`:
   - `Grafana Sync: Pull Dashboard From Dev Target`

## Ежедневный Workflow

Обычный цикл работы выглядит так:

1. Изменить дашборд в dev Grafana.
2. Выполнить `Grafana Sync: Pull Dashboard From Dev Target`.
3. Проверить или обновить:
   - datasource mappings
   - variable overrides
   - folder placement
   - target-specific dashboard UID
4. Выполнить `render` для нужных targets.
5. При необходимости выполнить `Grafana Sync: Pull Alerts` для нужного target.
6. Проверить render output и pulled alerts.
7. Закоммитить изменения в git.

## Работа С Дашбордами

В дереве `Dashboards` доступны основные действия:

- `Grafana Sync: Pull Dashboard From Dev Target`
- `Grafana Sync: Deploy Dashboard`
- `Grafana Sync: Render Dashboard`
- `Grafana Sync: Open Dashboard JSON`
- `Grafana Sync: Open Dashboard In Browser`
- `Grafana Sync: Remove Dashboard`

Для одного dashboard можно выполнять действия:

- только для `active target`
- для всех targets активного instance
- для всех instances

## Работа С Ревизиями

У каждого dashboard есть список revisions.

Доступные действия:

- `Grafana Sync: Checkout Revision`
  делает ревизию локальной рабочей копией
- `Grafana Sync: Set Revision On Active Target`
  назначает ревизию текущей для `active target`
- `Grafana Sync: Deploy Revision To Active Target`
  сразу раскатывает выбранную ревизию в `active target`
- `Grafana Sync: Delete Revision`
  удаляет неиспользуемую ревизию

Важно:

- `checked out` означает локальную рабочую копию
- `on active target` означает ревизию, закрепленную за выбранным `active target`

## Datasources

Datasource mappings настраиваются в `Details > Datasources`.

Формат хранения в `.grafana-dashboard-workspace.json`:

```json
{
  "datasources": {
    "integration": {
      "instances": {
        "prod": {
          "uid": "target-ds",
          "name": "Target Datasource"
        }
      }
    }
  }
}
```

Основной сценарий:

- выбрать datasource из списка, если target Grafana доступен

План Б:

- вручную ввести `Target Datasource Name`
- вручную ввести `Target Datasource UID`

Это полезно, если:

- target недоступен разработчику
- auto-resolve datasource не сработал
- значение известно заранее из production/test Grafana

Важно:

- для успешного target-specific `render` обычно нужен именно `uid`
- одно имя datasource можно сохранить как metadata, но без `uid` render может завершиться ошибкой, если mapping неразрешим

## Overrides

В `Details > Overrides` можно управлять поддерживаемыми dashboard variables:

- `custom`
- `textbox`
- `constant`

Override сохраняется не глобально, а для конкретной revision выбранного target.

Если меняется только значение managed override variable при `pull`, новая revision обычно не создается.

## Placement

В `Details > Placement` можно настроить:

- target-specific folder path
- target-specific dashboard UID

Это нужно, когда один и тот же dashboard должен жить по-разному на разных targets.

Новый workflow:

- `folderPath` можно ввести вручную
- под полем есть встроенный browser по папкам Grafana
- browser показывает текущий уровень, `..` для перехода вверх и вложенные папки
- `OK` только подставляет путь в поле
- фактическое сохранение делает кнопка `Save Placement`

Если target Grafana недоступен:

- ручной ввод path все равно остается доступным
- сохранение path не блокируется только из-за того, что такой папки сейчас не видно в Grafana

## Render

Основные команды:

- `Grafana Sync: Render Dashboard`
- `Grafana Sync: Render Target`
- `Grafana Sync: Render Instance`
- `Grafana Sync: Render All Instances`
- `Grafana Sync: Open Render Folder`

Render outputs сохраняются в:

```text
renders/<instance>/<target>/
```

Render использует:

- текущую revision target
- datasource mappings
- variable overrides
- placement overrides

## Alerts Pull

Команда:

- `Grafana Sync: Pull Alerts`

Что делает:

- загружает список rule из Grafana и дает выбрать конкретные alerts
- для выбранных alerts сохраняет сами rules и связанные `contact points` (по прямому receiver)
- сохраняет pretty JSON (читаемый diff)

Куда сохраняет:

```text
alerts/<instance>/<target>/
  manifest.json
  rules/<alert-uid>.json
  contact-points/<contact-point-key>.json
```

Важно:

- `Pull Alerts` не ограничен `dev target` (в отличие от `pull` dashboards)
- связь alert -> contact point в v1 только прямая (без полного resolve по policies)
- для alert без прямого receiver в details будет статус `policy-managed`

## Deploy Alert

Команда:

- `Grafana Sync: Deploy Alert`

Что делает:

- загружает выбранный локальный alert обратно в Grafana
- перед upload сравнивает локальную и текущую remote-версию
- если отличий нет, upload пропускается
- если alert связан с локальными contact points, они тоже upsert-ятся

## Deploy

Основные команды:

- `Grafana Sync: Deploy Dashboard`
- `Grafana Sync: Deploy All Dashboards`

Для revision из дерева:

- `Grafana Sync: Deploy Revision To Active Target`

Рекомендуемый процесс для shared environments:

- разработчик делает `render`
- итоговые файлы попадают в git
- официальный deploy выполняется через GitLab

## Backups

Плагин умеет создавать и восстанавливать raw backups.

Основные команды:

- `Grafana Sync: Create Backup`
- `Grafana Sync: Create Backup of All Dashboards`
- `Grafana Sync: Restore Backup`

Backups особенно полезны перед deploy или перед массовыми изменениями.

## Recommended Access Model

Практичная схема работы:

- у разработчика есть рабочий доступ в `dev`
- у разработчика есть `read-only` token в `prod`
- у GitLab есть `write` token для `test` и `prod`

Это позволяет:

- делать `pull` из dev
- заранее видеть datasource metadata из prod
- выполнять локальный `render` для `test/prod`
- не давать разработчику случайно делать ручной deploy в shared environments

## Аутентификация Instance

Поддерживаются два режима:

- bearer token
- basic auth через `GRAFANA_USERNAME` и пароль

Практические правила:

- если у instance сохранен token, плагин использует его
- если token не задан, но сохранены `GRAFANA_USERNAME` и пароль, плагин использует basic auth
- пароль хранится в VS Code Secret Storage
- `GRAFANA_URL` и username хранятся в `.grafana-dashboard-workspace.json`

Команды:

- `Grafana Sync: Set Instance Token`
- `Grafana Sync: Clear Instance Token`
- `Grafana Sync: Set Instance Password`
- `Grafana Sync: Clear Instance Password`

## Типовые Ошибки

`Datasource mappings are missing`

- для target не разрешен datasource `uid`
- открой `Details > Datasources`
- выбери datasource из списка или введи `name` и `uid` вручную

`Pull is allowed only from dev target`

- выбран не тот target
- сначала выполни `Grafana Sync: Select Dev Target`

`Current revision is not set`

- для target еще не назначена ревизия
- выбери revision через `Grafana Sync: Set Revision On Active Target`

## Где Смотреть Дальше

- общий обзор проекта: [README.md](README.md)
- процесс разработки и поставки: [DEVELOPMENT_AND_DELIVERY.md](DEVELOPMENT_AND_DELIVERY.md)
- локальная сборка: [LOCAL_BUILD.md](LOCAL_BUILD.md)
