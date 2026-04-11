# Lunor SDK

Prywatny pakiet SDK do monitorowania i logowania dla platformy Lunor. Wspiera środowiska przeglądarkowe (Browser) oraz serwerowe (Node.js).

## Spis treści
- [O projekcie](#o-projekcie)
- [Główne funkcje](#główne-funkcje)
- [Architektura](#architektura)
- [Struktura projektu](#struktura-projektu)
- [Opis plików](#opis-plików)
- [Konfiguracja](#konfiguracja)

## O projekcie
`lunor-sdk` to zaawansowane narzędzie do zbierania logów, błędów, informacji diagnostycznych oraz zdarzeń bezpieczeństwa. SDK automatycznie gromadzi kontekst wykonania (system operacyjny, wersja środowiska, lokalizacja), zapewnia odporność na błędy sieciowe dzięki systemowi kolejek i ponowień (retry) oraz minimalizuje wpływ na wydajność aplikacji poprzez asynchroniczne wysyłanie danych w paczkach (batching).

## Główne funkcje
- **Unified Logging API**: Prosty interfejs do logowania na różnych poziomach (DEBUG, INFO, WARN, ERROR, FATAL).
- **Automatyczne przechwytywanie błędów**: Obsługa `uncaughtException`, `unhandledRejection` oraz błędów runtime w przeglądarce.
- **Intercepcja konsoli**: Opcjonalne przechwytywanie wywołań `console.log`, `console.error` itp.
- **Persistent Queue**: Kolejkowanie zdarzeń z opcjonalnym zapisem w `localStorage`, co zapobiega utracie danych przy odświeżeniu strony lub awarii.
- **Batching & Flushing**: Efektywne wysyłanie danych w paczkach w określonych odstępach czasu lub po osiągnięciu limitu rozmiaru.
- **Retry Logic**: Zaawansowany mechanizm ponowień z wykładniczym czasem oczekiwania (exponential backoff) i jitterem.
- **Context Collection**: Automatyczne zbieranie metadanych o środowisku (OS, Browser, Node version, Memory, URL, UserAgent).
- **Middleware & Hooks**: Możliwość modyfikacji lub filtrowania zdarzeń przed wysłaniem poprzez middleware lub hook `beforeSend`.
- **Performance Monitoring**: Narzędzia do pomiaru czasu wykonywania kodu i operacji asynchronicznych.
- **Sampling**: Możliwość ograniczenia ilości wysyłanych danych poprzez próbkowanie procentowe.

## Architektura
Projekt został zaprojektowany w sposób modułowy:
1. **Client (`LunorClient`)**: Centralny punkt zarządzania SDK, koordynuje pracę pozostałych komponentów.
2. **Transport**: Warstwa sieciowa odpowiedzialna za komunikację z API Lunor.
3. **Queue**: Zarządza buforowaniem zdarzeń i ich trwałością.
4. **Global Handlers**: Podpina się pod zdarzenia systemowe środowiska uruchomieniowego.
5. **Context**: Odpowiada za detekcję i ekstrakcję metadanych środowiskowych.

## Struktura projektu
```text
/home/ak6616/lunor-sdk/
├── src/                        # Kod źródłowy TypeScript
│   ├── client.ts               # Główna klasa LunorClient
│   ├── constants.ts            # Stałe i domyślna konfiguracja
│   ├── context.ts              # Zbieranie metadanych środowiskowych
│   ├── global-handlers.ts      # Obsługa błędów globalnych i konsoli
│   ├── index.ts                # Punkt wejściowy (Entry point)
│   ├── middleware.ts           # Mechanizm potoków (middleware)
│   ├── queue.ts                # Zarządzanie kolejką i trwałością
│   ├── retry.ts                # Logika ponowień (retry)
│   ├── transport.ts            # Komunikacja sieciowa (fetch)
│   ├── types.ts                # Definicje typów, interfejsów i enumów
│   └── utils.ts                # Funkcje pomocnicze
├── package.json                # Metadane npm i zależności
├── tsconfig.json               # Konfiguracja kompilatora TypeScript
├── tsup.config.ts              # Konfiguracja buildera (tsup)
├── vitest.config.ts            # Konfiguracja testów (Vitest)
└── build.sh                    # Skrypt pomocniczy do budowania
```

## Opis plików

### Katalog `src/`
- **`index.ts`**: Eksportuje publiczne API. Zawiera implementację wzorca Singleton (`init`, `getInstance`) oraz fabrykę klientów.
- **`client.ts`**: Zawiera klasę `LunorClient`. Odpowiada za inicjalizację, metody logowania (`log`, `debug`, `captureError`), zarządzanie cyklem życia (timer flushera, shutdown handlery) oraz orkiestrację przepływu zdarzeń.
- **`transport.ts`**: Klasa `Transport` obsługująca wysyłanie danych przez `fetch`. Implementuje limit współbieżności dla paczek oraz integruje się z mechanizmem retry.
- **`queue.ts`**: Klasa `PersistentQueue`. Zarządza tablicą zdarzeń, dba o limity rozmiaru (eviction policy) oraz opcjonalnie synchronizuje stan z `localStorage`.
- **`types.ts`**: Definiuje wszystkie kluczowe struktury danych, w tym `LogLevel`, `ErrorType`, `Severity`, `SecurityType` oraz interfejsy dla konfiguracji i payloadów.
- **`constants.ts`**: Przechowuje niezmienne wartości, takie jak adres endpointu API, wersja SDK oraz domyślne ustawienia konfiguracyjne.
- **`context.ts`**: Zawiera logikę wykrywania runtime'u i automatycznego zbierania informacji o przeglądarce (URL, UserAgent, rozdzielczość) lub procesie Node.js (wersja, hostname, zużycie pamięci).
- **`global-handlers.ts`**: Implementuje mechanizmy "wpinania się" w globalne zdarzenia błędów i przechwytywania metod obiektu `console`.
- **`middleware.ts`**: Implementacja prostego łańcucha middleware, który pozwala na asynchroniczne przetwarzanie zdarzeń przed ich zakolejkowaniem.
- **`retry.ts`**: Uniwersalna funkcja opakowująca operacje asynchroniczne w logikę ponowień z wykładniczym opóźnieniem.
- **`utils.ts`**: Zbiór funkcji narzędziowych: bezpieczna serializacja JSON, generowanie ID, detekcja środowiska, operacje na stack trace itp.

### Pliki konfiguracyjne
- **`package.json`**: Definiuje projekt jako moduł hybrydowy (ESM/CJS), określa skrypty budowania i wymagane silniki (Node >= 18).
- **`tsup.config.ts`**: Konfiguracja narzędzia `tsup` do generowania zoptymalizowanych paczek dystrybucyjnych (`dist/`) z definicjami typów `.d.ts`.
- **`tsconfig.json`**: Standardowa konfiguracja TypeScript dla nowoczesnych projektów JS.

## Konfiguracja
SDK wymaga podania `apiKey` oraz `apiSecret` przy inicjalizacji. Większość parametrów (batchSize, flushInterval, sampleRate) jest opcjonalna i posiada bezpieczne wartości domyślne zdefiniowane w `constants.ts`.
