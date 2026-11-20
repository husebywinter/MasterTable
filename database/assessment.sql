-- ============================================================
-- Vurderingstabell - Azure SQL schema for AssessmentVisual
--
--  * One row per table row: Context x Key1 x Key2 x Key3
--    (Context separates different reports/uses, e.g. 'Ratejustering')
--  * Two editable fields: Category (from dbo.AssessmentCategory) and Comment
--  * System-versioned temporal table: every change/delete is kept in history
--  * Row-level optimistic concurrency, same pattern as usp_SavePlanCells
--
-- Standalone; can share a database with other schemas. Safe to re-run.
-- ============================================================

-- ── 1. Categories ─────────────────────────────────────────────────────────
-- The visual's dropdown list is set in Format > Kategorier; the values must
-- exist here (and be active) or the save is rejected.

IF OBJECT_ID('dbo.AssessmentCategory') IS NULL
CREATE TABLE dbo.AssessmentCategory (
    Code        NVARCHAR(50)    NOT NULL CONSTRAINT PK_AssessmentCategory PRIMARY KEY,
    SortOrder   INT             NOT NULL,
    IsActive    BIT             NOT NULL CONSTRAINT DF_AssessmentCategory_IsActive DEFAULT 1
);
GO

INSERT INTO dbo.AssessmentCategory (Code, SortOrder)
SELECT v.Code, v.SortOrder
FROM (VALUES (N'Justert', 1), (N'Ikke justert', 2), (N'Kan ikke justeres', 3)) v (Code, SortOrder)
WHERE NOT EXISTS (SELECT 1 FROM dbo.AssessmentCategory c WHERE c.Code = v.Code);
GO

-- ── 2. Assessments (temporal) ─────────────────────────────────────────────
-- Unused key levels are stored as ''. A row needs a category or a comment;
-- clearing both deletes the row (it lives on in dbo.AssessmentHistory, with
-- ModifiedBy set to the user who cleared it).

IF OBJECT_ID('dbo.Assessment') IS NULL
CREATE TABLE dbo.Assessment (
    Context     NVARCHAR(100)   NOT NULL,
    Key1        NVARCHAR(200)   NOT NULL,
    Key2        NVARCHAR(200)   NOT NULL CONSTRAINT DF_Assessment_Key2 DEFAULT N'',
    Key3        NVARCHAR(200)   NOT NULL CONSTRAINT DF_Assessment_Key3 DEFAULT N'',
    Category    NVARCHAR(50)    NULL CONSTRAINT FK_Assessment_Category REFERENCES dbo.AssessmentCategory,
    Comment     NVARCHAR(2000)  NULL,
    ModifiedBy  NVARCHAR(200)   NOT NULL,
    BatchId     UNIQUEIDENTIFIER NOT NULL,
    ValidFrom   DATETIME2       GENERATED ALWAYS AS ROW START NOT NULL,
    ValidTo     DATETIME2       GENERATED ALWAYS AS ROW END   NOT NULL,
    PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo),
    CONSTRAINT PK_Assessment PRIMARY KEY (Context, Key1, Key2, Key3),
    CONSTRAINT CK_Assessment_NotEmpty CHECK (Category IS NOT NULL OR Comment IS NOT NULL)
)
WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = dbo.AssessmentHistory));
GO

-- ── 3. Save log (BatchId makes retries idempotent) ────────────────────────

IF OBJECT_ID('dbo.AssessmentSaveBatch') IS NULL
CREATE TABLE dbo.AssessmentSaveBatch (
    BatchId     UNIQUEIDENTIFIER CONSTRAINT PK_AssessmentSaveBatch PRIMARY KEY,
    Context     NVARCHAR(100)   NOT NULL,
    SavedBy     NVARCHAR(200)   NOT NULL,
    SavedAt     DATETIME2       NOT NULL CONSTRAINT DF_AssessmentSaveBatch_SavedAt DEFAULT SYSUTCDATETIME(),
    Inserted    INT             NOT NULL,
    Updated     INT             NOT NULL,
    Deleted     INT             NOT NULL,
    Payload     NVARCHAR(MAX)   NULL
);
GO

-- ── 4. Save procedure ─────────────────────────────────────────────────────
--
-- @Payload:
-- { "rows": [ { "keys": ["P100", "2026"],
--               "category": "Justert", "comment": "Avtalt med kunde",
--               "originalCategory": null, "originalComment": null } ] }
--
-- "original*" is what the user saw. A row is in conflict when the stored
-- (Category, Comment) differs from both the original and the new pair, i.e.
-- someone else changed it. Any conflict rolls back the whole save.
-- category and comment both null/empty = delete the row.
--
-- Result: @Status = 'saved' | 'duplicate' | 'conflict', plus one result set
-- with conflicts (empty unless @Status = 'conflict').
-- Errors: 50400 invalid payload.

CREATE OR ALTER PROCEDURE dbo.usp_SaveAssessments
    @BatchId    UNIQUEIDENTIFIER,
    @Context    NVARCHAR(100),
    @SavedBy    NVARCHAR(200),
    @Payload    NVARCHAR(MAX),
    @Status     VARCHAR(20) OUTPUT,
    @Inserted   INT OUTPUT,
    @Updated    INT OUTPUT,
    @Deleted    INT OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    SELECT @Inserted = 0, @Updated = 0, @Deleted = 0;

    CREATE TABLE #conflicts (
        Key1            NVARCHAR(200)   NOT NULL,
        Key2            NVARCHAR(200)   NOT NULL,
        Key3            NVARCHAR(200)   NOT NULL,
        CurrentCategory NVARCHAR(50)    NULL,
        CurrentComment  NVARCHAR(2000)  NULL,
        ModifiedBy      NVARCHAR(200)   NULL,
        ModifiedAt      DATETIME2       NULL
    );

    IF EXISTS (SELECT 1 FROM dbo.AssessmentSaveBatch WHERE BatchId = @BatchId)
    BEGIN
        SET @Status = 'duplicate';
        SELECT * FROM #conflicts;
        RETURN;
    END;

    IF ISJSON(@Payload) = 0 THROW 50400, 'Payload is not valid JSON.', 1;
    IF NULLIF(LTRIM(@Context), N'') IS NULL THROW 50400, 'Missing context.', 1;

    -- Parse; empty strings are treated as null
    SELECT ISNULL(j.Key1, N'') AS Key1, ISNULL(j.Key2, N'') AS Key2, ISNULL(j.Key3, N'') AS Key3,
           NULLIF(LTRIM(RTRIM(j.NewCategory)), N'')      AS NewCategory,
           NULLIF(LTRIM(RTRIM(j.NewComment)), N'')       AS NewComment,
           NULLIF(LTRIM(RTRIM(j.OriginalCategory)), N'') AS OriginalCategory,
           NULLIF(LTRIM(RTRIM(j.OriginalComment)), N'')  AS OriginalComment
    INTO #rows
    FROM OPENJSON(@Payload, '$.rows') WITH (
            Key1             NVARCHAR(200)  '$.keys[0]',
            Key2             NVARCHAR(200)  '$.keys[1]',
            Key3             NVARCHAR(200)  '$.keys[2]',
            NewCategory      NVARCHAR(50)   '$.category',
            NewComment       NVARCHAR(2000) '$.comment',
            OriginalCategory NVARCHAR(50)   '$.originalCategory',
            OriginalComment  NVARCHAR(2000) '$.originalComment'
         ) j;

    -- Validate
    DECLARE @msg NVARCHAR(2048);
    IF NOT EXISTS (SELECT 1 FROM #rows) THROW 50400, 'Nothing to save.', 1;
    IF EXISTS (SELECT 1 FROM #rows WHERE Key1 = N'')
        THROW 50400, 'Each row needs at least one key.', 1;
    IF EXISTS (SELECT 1 FROM #rows GROUP BY Key1, Key2, Key3 HAVING COUNT(*) > 1)
        THROW 50400, 'Payload contains the same row more than once.', 1;

    SELECT @msg = LEFT(STRING_AGG(CAST(CONCAT(N'"', r.NewCategory, N'"') AS NVARCHAR(MAX)), ', '), 1000)
    FROM (SELECT DISTINCT NewCategory FROM #rows WHERE NewCategory IS NOT NULL) r
    WHERE NOT EXISTS (SELECT 1 FROM dbo.AssessmentCategory c WHERE c.Code = r.NewCategory AND c.IsActive = 1);
    IF @msg IS NOT NULL
    BEGIN
        SET @msg = CONCAT('Unknown category: ', @msg);
        THROW 50400, @msg, 1;
    END;

    BEGIN TRANSACTION;

    -- Conflicts (UPDLOCK/HOLDLOCK keeps the rows - and missing rows - locked until commit).
    -- INTERSECT gives null-safe comparison of the (Category, Comment) pairs.
    INSERT INTO #conflicts (Key1, Key2, Key3, CurrentCategory, CurrentComment, ModifiedBy, ModifiedAt)
    SELECT s.Key1, s.Key2, s.Key3, t.Category, t.Comment, t.ModifiedBy, t.ValidFrom
    FROM #rows s
    LEFT JOIN dbo.Assessment t WITH (UPDLOCK, HOLDLOCK)
           ON t.Context = @Context AND t.Key1 = s.Key1 AND t.Key2 = s.Key2 AND t.Key3 = s.Key3
    WHERE NOT EXISTS (SELECT t.Category, t.Comment INTERSECT SELECT s.OriginalCategory, s.OriginalComment)
      AND NOT EXISTS (SELECT t.Category, t.Comment INTERSECT SELECT s.NewCategory, s.NewComment);

    IF EXISTS (SELECT 1 FROM #conflicts)
    BEGIN
        ROLLBACK;
        SET @Status = 'conflict';
        SELECT * FROM #conflicts;
        RETURN;
    END;

    UPDATE t SET Category = s.NewCategory, Comment = s.NewComment, ModifiedBy = @SavedBy, BatchId = @BatchId
    FROM dbo.Assessment t
    JOIN #rows s ON t.Context = @Context AND t.Key1 = s.Key1 AND t.Key2 = s.Key2 AND t.Key3 = s.Key3
    WHERE (s.NewCategory IS NOT NULL OR s.NewComment IS NOT NULL)
      AND NOT EXISTS (SELECT t.Category, t.Comment INTERSECT SELECT s.NewCategory, s.NewComment);
    SET @Updated += @@ROWCOUNT;

    INSERT INTO dbo.Assessment (Context, Key1, Key2, Key3, Category, Comment, ModifiedBy, BatchId)
    SELECT @Context, s.Key1, s.Key2, s.Key3, s.NewCategory, s.NewComment, @SavedBy, @BatchId
    FROM #rows s
    WHERE (s.NewCategory IS NOT NULL OR s.NewComment IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM dbo.Assessment t
                      WHERE t.Context = @Context AND t.Key1 = s.Key1 AND t.Key2 = s.Key2 AND t.Key3 = s.Key3);
    SET @Inserted += @@ROWCOUNT;

    -- Stamp the deleting user first, so history shows who cleared the row
    UPDATE t SET ModifiedBy = @SavedBy, BatchId = @BatchId
    FROM dbo.Assessment t
    JOIN #rows s ON t.Context = @Context AND t.Key1 = s.Key1 AND t.Key2 = s.Key2 AND t.Key3 = s.Key3
    WHERE s.NewCategory IS NULL AND s.NewComment IS NULL;

    DELETE t
    FROM dbo.Assessment t
    JOIN #rows s ON t.Context = @Context AND t.Key1 = s.Key1 AND t.Key2 = s.Key2 AND t.Key3 = s.Key3
    WHERE s.NewCategory IS NULL AND s.NewComment IS NULL;
    SET @Deleted += @@ROWCOUNT;

    INSERT INTO dbo.AssessmentSaveBatch (BatchId, Context, SavedBy, Inserted, Updated, Deleted, Payload)
    VALUES (@BatchId, @Context, @SavedBy, @Inserted, @Updated, @Deleted, @Payload);

    COMMIT;
    SET @Status = 'saved';
    SELECT * FROM #conflicts;
END;
GO

-- ── 5. Views for Power BI (DirectQuery) ───────────────────────────────────
-- RowKey = the key values joined with '|', the same order as the fields in
-- the visual's "Radnøkkel" well. Use it to relate to your fact/dim table.

CREATE OR ALTER VIEW dbo.vw_Assessment AS
SELECT a.Context, a.Key1, a.Key2, a.Key3,
       CONCAT_WS(N'|', a.Key1, NULLIF(a.Key2, N''), NULLIF(a.Key3, N'')) AS RowKey,
       a.Category, c.SortOrder AS CategorySort, a.Comment,
       a.ModifiedBy, a.ValidFrom AS ModifiedAt
FROM dbo.Assessment a
LEFT JOIN dbo.AssessmentCategory c ON c.Code = a.Category;
GO

-- ValidTo = 9999-12-31 is the current version; a row whose latest version
-- has an earlier ValidTo was cleared.
CREATE OR ALTER VIEW dbo.vw_AssessmentHistory AS
SELECT a.Context, a.Key1, a.Key2, a.Key3,
       CONCAT_WS(N'|', a.Key1, NULLIF(a.Key2, N''), NULLIF(a.Key3, N'')) AS RowKey,
       a.Category, a.Comment, a.ModifiedBy, a.BatchId, a.ValidFrom, a.ValidTo
FROM dbo.Assessment FOR SYSTEM_TIME ALL a;
GO

-- ── Examples ──────────────────────────────────────────────────────────────
-- New category:      INSERT dbo.AssessmentCategory (Code, SortOrder) VALUES (N'Under vurdering', 4);
-- Retire a category: UPDATE dbo.AssessmentCategory SET IsActive = 0 WHERE Code = N'Kan ikke justeres';
-- Who changed a row: SELECT * FROM dbo.vw_AssessmentHistory
--                    WHERE Context = N'Ratejustering' AND RowKey = N'P100|2026' ORDER BY ValidFrom;
