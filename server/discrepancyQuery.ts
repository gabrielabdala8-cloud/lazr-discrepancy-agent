/** 
 * Full discrepancy query — all customers, last 6 months.
 * Line 251 filter (org.name = 'AMD MEDICOM INC. (MED)') removed.
 */
export const DISCREPANCY_SQL = `
SELECT 
    o.number AS "Order Number",
    o.status AS "Order Status",
    rfq.status AS "RFQ Status",
    rfq.transport_type AS "Transport Type",
    quote.service_level_type AS "Service Type",

    (
        SELECT STRING_AGG(DISTINCT qc.code, ', ')
        FROM lazr.quote_charge qc
        WHERE qc.quote_id = quote.id
          AND qc.code NOT IN ('WGHT','DIMWGHT','ASWGHT')
    ) AS "Accessorial",

    quote.account_number AS "Account Number",
    org.name AS "Organization Name",

    rfq.origin_company_name AS "Origin Company Name",
    rfq.destination_company_name AS "Destination Company Name",

    TRIM(
        COALESCE(u.first_name,'') ||
        CASE WHEN u.first_name IS NOT NULL AND u.last_name IS NOT NULL THEN ' ' ELSE '' END ||
        COALESCE(u.last_name,'')
    ) AS "Created By User Name",
    COALESCE(u.email,'') AS "Created By User Email",

    rfq.origin_pickup_date AS "Origin Pickup Date",
    UPPER(rfq.origin_city) AS "Origin City",
    UPPER(rfq.origin_state) AS "Origin State",
    UPPER(rfq.origin_postal_code) AS "Origin Postal Code",
    UPPER(rfq.origin_country) AS "Origin Country",
    UPPER(rfq.destination_city) AS "Destination City",
    UPPER(rfq.destination_state) AS "Destination State",
    UPPER(rfq.destination_postal_code) AS "Destination Postal Code",
    UPPER(rfq.destination_country) AS "Destination Country",

    CONCAT(UPPER(rfq.origin_state), ' -> ', UPPER(rfq.destination_state)) AS "Lane (Origin -> Destination Province)",

    COALESCE(quote.carrier_display_name,'') AS "Carrier Name",
    quote.currency AS "Quote Currency",

    (SELECT ROUND(SUM(
        CASE
            WHEN total_volume_unit = 'FT3'
                THEN (quantity*length/12*width/12*height/12)
            ELSE quantity*length*width*height/28317
        END),2)
     FROM lazr.handling_unit hu
     WHERE hu.rfq_id = rfq.id) AS "Total Volume (FT3)",

    (SELECT ROUND(SUM(
        CASE
            WHEN weight_unit = 'LB'
                THEN total_weight
            ELSE total_weight*2.20462
        END),2)
     FROM lazr.handling_unit hu
     WHERE hu.rfq_id = rfq.id) AS "Total Weight (LBS)",

    COALESCE(pr_latest.reviewed_cost_cad, quote.cost_raw_cad) AS "Reconciled Quote Price cad",

    COALESCE(
        quote.cost_total_cad::numeric,
        NULLIF(wl.selling_cad, '')::numeric,
        0::numeric
    ) AS "Selling Price (CAD)",

    COALESCE(
        pr_latest.reviewed_selling_cad,
        quote.cost_total_cad::numeric,
        NULLIF(wl.selling_cad, '')::numeric,
        0::numeric
    ) AS "Billed Selling Price (CAD)",

    ROUND(
        COALESCE(
            pr_latest.reviewed_selling_cad,
            quote.cost_total_cad::numeric,
            NULLIF(wl.selling_cad, '')::numeric,
            0::numeric
        )
        -
        COALESCE(pr_latest.reviewed_cost_cad, quote.cost_raw_cad::numeric, 0::numeric)
    , 2) AS "Margin (CAD $)",

    ROUND(
        100 *
        (
            COALESCE(
                pr_latest.reviewed_selling_cad,
                quote.cost_total_cad::numeric,
                NULLIF(wl.selling_cad, '')::numeric,
                0::numeric
            )
            -
            COALESCE(pr_latest.reviewed_cost_cad, quote.cost_raw_cad::numeric, 0::numeric)
        )
        / NULLIF(
            COALESCE(
                pr_latest.reviewed_selling_cad,
                quote.cost_total_cad::numeric,
                NULLIF(wl.selling_cad, '')::numeric,
                0::numeric
            ),
            0::numeric
        )
    , 2) AS "Margin (%)"

FROM lazr."order" o
JOIN lazr.rfq rfq ON rfq.order_id = o.id
LEFT JOIN lazr."user" u ON o.created_by_user_id = u.id
LEFT JOIN lazr.quote quote ON rfq.selected_quote_id = quote.id
JOIN lazr.organization org ON org.id = o.client_organization_id
LEFT JOIN lazr.weekly_lazr wl
    ON wl.order_number = o.number

LEFT JOIN LATERAL (
    SELECT
        pr.raw_cad::numeric   AS reviewed_cost_cad,
        pr.total_cad::numeric AS reviewed_selling_cad,
        pr.created_at,
        pr.created_by_user_id
    FROM lazr.price_review pr
    WHERE pr.order_id = o.id
      AND pr.is_deleted = FALSE
    ORDER BY pr.created_at DESC
    LIMIT 1
) pr_latest ON TRUE

WHERE rfq.transport_type IN ('LTL','PARCEL', 'PAK', 'ENVELOPE','EXPRESS_BOX','TUBE')
  AND rfq.status IN ('CARRIER_DISPATCHED')
  AND o.status NOT IN ('GHOST', 'DRAFT')
  AND rfq.origin_pickup_date >= (CURRENT_DATE - INTERVAL '6 months')

ORDER BY "Order Number" DESC
`;
