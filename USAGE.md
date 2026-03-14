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

## Быстрый Старт

1. Открой папку проекта в VS Code.
2. Выполни `Grafana Sync: Initialize Grafana Dashboard Project`.
3. В дереве `Instances` создай instance:
   - `Grafana Sync: Create Instance`
4. Для instance задай `GRAFANA_URL`.
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
5. Проверить render output.
6. Закоммитить изменения в git.

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
- username хранится в конфигурации проекта

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
