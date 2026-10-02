//! 날씨: open-meteo 지오코딩 → 현재 날씨 + 3일 예보.

use crate::error::AppError;
use crate::http::{client, urlencode};
use serde::Serialize;
use std::sync::Mutex;

/// 고양이 옆에 띄우는 지금 날씨. 툴용 `run` 과 달리 사람이 읽을 문장이 아니라 값이다.
#[derive(Serialize)]
pub struct WeatherNow {
    pub place: String,
    pub label: String,
    pub emoji: String,
    pub temp: f64,
}

pub async fn now(location: &str) -> Result<WeatherNow, AppError> {
    let (lat, lon, place) = geocode(location).await?;
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,weather_code,is_day&timezone=auto"
    );
    let w: serde_json::Value = client().get(&url).send().await?.json().await?;
    let cur = &w["current"];
    let code = cur["weather_code"].as_i64().unwrap_or(-1);
    let night = cur["is_day"].as_i64() == Some(0);
    let label = code_to_str(code).split(' ').next().unwrap_or("").to_string();
    Ok(WeatherNow {
        place,
        label,
        emoji: code_to_emoji(code, night).to_string(),
        temp: cur["temperature_2m"].as_f64().unwrap_or(0.0),
    })
}

/// 지명 → (위도, 경도, 찾은 이름).
///
/// 마지막 하나를 기억한다. 배지가 30분마다 같은 지역을 묻는데 좌표는 안 바뀌니
/// 매번 지오코딩하면 요청만 두 배가 된다.
async fn geocode(location: &str) -> Result<(f64, f64, String), AppError> {
    if let Some(hit) = parse_coords(location) {
        return Ok(hit);
    }
    static LAST: Mutex<Option<(String, (f64, f64, String))>> = Mutex::new(None);
    if let Some((key, hit)) = LAST.lock()?.as_ref() {
        if key == location {
            return Ok(hit.clone());
        }
    }
    let found = lookup(location).await?;
    *LAST.lock()? = Some((location.to_string(), found.clone()));
    Ok(found)
}

/// `"역삼동 (37.5000,127.0364)"` — 설정의 "현재 위치" 버튼이 채우는 꼴. 괄호 안 좌표를 쓴다.
fn parse_coords(location: &str) -> Option<(f64, f64, String)> {
    let inner = location.trim().strip_suffix(')')?;
    let (name, coords) = inner.rsplit_once('(')?;
    let (lat, lon) = coords.split_once(',')?;
    let name = name.trim();
    let place = if name.is_empty() { "현재 위치" } else { name };
    Some((lat.trim().parse().ok()?, lon.trim().parse().ok()?, place.to_string()))
}

async fn lookup(location: &str) -> Result<(f64, f64, String), AppError> {
    let geo_url = format!(
        "https://geocoding-api.open-meteo.com/v1/search?name={}&count=1&language=ko&format=json",
        urlencode(location)
    );
    let geo: serde_json::Value = client().get(&geo_url).send().await?.json().await?;

    let results = geo["results"]
        .as_array()
        .filter(|r| !r.is_empty())
        .ok_or_else(|| AppError::msg(format!("'{location}' 위치를 찾을 수 없습니다.")))?;
    let lat = results[0]["latitude"].as_f64().unwrap_or(0.0);
    let lon = results[0]["longitude"].as_f64().unwrap_or(0.0);
    let place = results[0]["name"].as_str().unwrap_or(location).to_string();
    Ok((lat, lon, place))
}

pub async fn run(location: &str) -> Result<String, AppError> {
    let (lat, lon, place) = geocode(location).await?;

    let weather_url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,apparent_temperature&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FSeoul&forecast_days=3"
    );
    let weather: serde_json::Value = client().get(&weather_url).send().await?.json().await?;

    let cur = &weather["current"];
    let temp = cur["temperature_2m"].as_f64().unwrap_or(0.0);
    let feels = cur["apparent_temperature"].as_f64().unwrap_or(temp);
    let humidity = cur["relative_humidity_2m"].as_i64().unwrap_or(0);
    let wind = cur["wind_speed_10m"].as_f64().unwrap_or(0.0);
    let code = cur["weather_code"].as_i64().unwrap_or(0);

    let mut out = format!(
        "{} 현재 날씨\n{} | {:.1}°C (체감 {:.1}°C)\n습도 {}% | 바람 {:.1}km/h",
        place,
        code_to_str(code),
        temp,
        feels,
        humidity,
        wind
    );

    let daily = &weather["daily"];
    let max_temps = daily["temperature_2m_max"].as_array();
    let min_temps = daily["temperature_2m_min"].as_array();
    let precip = daily["precipitation_probability_max"].as_array();
    let labels = ["오늘", "내일", "모레"];
    for (i, label) in labels.iter().enumerate() {
        let tmax = max_temps.and_then(|a| a.get(i)).and_then(|v| v.as_f64());
        let tmin = min_temps.and_then(|a| a.get(i)).and_then(|v| v.as_f64());
        let rain = precip.and_then(|a| a.get(i)).and_then(|v| v.as_i64());
        if let (Some(mx), Some(mn)) = (tmax, tmin) {
            let rain_str = rain.map(|r| format!(" 강수 {r}%")).unwrap_or_default();
            out.push_str(&format!("\n{label}: 최고 {mx:.0}°C / 최저 {mn:.0}°C{rain_str}"));
        }
    }
    Ok(out)
}

/// 그림 문자로 그려지게 VS16(U+FE0F)을 붙인다. 안 붙이면 ☀ 이 흑백 글자로 나온다.
fn code_to_emoji(code: i64, night: bool) -> &'static str {
    match code {
        0 | 1 if night => "🌙",
        0 => "☀️",
        1 => "🌤️",
        2 => "⛅",
        3 => "☁️",
        45 | 48 => "🌫️",
        51 | 53 | 55 | 80 | 81 | 82 => "🌦️",
        61 | 63 | 65 => "🌧️",
        71 | 73 | 75 | 85 | 86 => "🌨️",
        77 => "❄️",
        95 | 96 | 99 => "⛈️",
        _ => "🌡️",
    }
}

fn code_to_str(code: i64) -> &'static str {
    match code {
        0 => "맑음 ☀",
        1 => "대체로 맑음 🌤",
        2 => "부분 흐림 ⛅",
        3 => "흐림 ☁",
        45 | 48 => "안개 🌫",
        51 | 53 | 55 => "이슬비 🌦",
        61 | 63 => "비 🌧",
        65 => "강한 비 🌧",
        71 | 73 | 75 => "눈 🌨",
        77 => "눈보라 ❄",
        80 | 81 | 82 => "소나기 🌦",
        85 | 86 => "눈 소나기 🌨",
        95 => "천둥번개 ⛈",
        96 | 99 => "우박 동반 뇌우 ⛈",
        _ => "알 수 없음",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_coords_written_by_current_location() {
        assert_eq!(parse_coords("역삼동 (37.5000,127.0364)"), Some((37.5, 127.0364, "역삼동".into())));
        assert_eq!(parse_coords("(37.5,127)"), Some((37.5, 127.0, "현재 위치".into())));
        assert_eq!(parse_coords("Seoul"), None);
        assert_eq!(parse_coords("Paris (France)"), None);
    }
}
